import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { parseStartupEvents, summarizeStartupAttempt } from './modules/cold-package-startup.mjs'
import { upgradeUserEnvironment } from './modules/upgrade-user-environment.mjs'
import { stopProcessGroup } from './process-lifecycle.mjs'
import { INSTALLED_PREPARATION_ARGUMENT } from '../../electron/src/runtime/installed-preparation-contract.mjs'

const execute = promisify(execFile)
const output = resolve('.ci-artifacts/windows-startup-comparison.json')
const shas = { baseline: process.argv[2], candidate: process.argv[3] }
const variants = [
  { name: 'baseline', build: 'baseline', prepare: false },
  { name: 'candidate', build: 'candidate', prepare: true },
  { name: 'candidateWithoutPreparation', build: 'candidate', prepare: false },
]
const sampleOrders = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
]
const samples = []

async function launch(binary, env, logFile) {
  await rm(logFile, { force: true })
  const startedAt = performance.now()
  const child = spawn(binary, [], { env, stdio: 'ignore', windowsHide: true })
  let spawnError
  child.once('error', error => {
    spawnError = error
  })
  try {
    for (;;) {
      if (spawnError) throw spawnError
      assert.equal(child.exitCode, null, 'Packaged app exited before showing its main window')
      const log = await readFile(logFile, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      const { mainWindowShowElapsedMs, phaseDurationsMs } = summarizeStartupAttempt(
        parseStartupEvents(log)
      )
      const elapsedMs = Math.round(performance.now() - startedAt)
      if (mainWindowShowElapsedMs !== null) {
        return {
          processToWindowMs: elapsedMs,
          mainToWindowMs: mainWindowShowElapsedMs,
          phaseDurationsMs,
        }
      }
      assert.ok(elapsedMs < 180_000, 'Packaged app never reported main-window-show')
      await delay(50)
    }
  } finally {
    if (child.pid) await stopProcessGroup(child)
  }
}

async function measure({ name, build, prepare }, round) {
  const bundle = resolve(build, 'wework/electron/release/WeWork-win32-x64')
  const manifest = JSON.parse(await readFile(join(bundle, 'resources', 'components.json'), 'utf8'))
  assert.equal(manifest.sourceSha, shas[build], 'Packaged source revision must match the test')
  const binary = join(bundle, 'WeWork.exe')
  const home = await mkdtemp(join(tmpdir(), 'ww-ab-'))
  const userData = join(home, 'data')
  const appData = join(home, 'roaming')
  const localAppData = join(home, 'local')
  const env = {
    ...upgradeUserEnvironment(process.env, home),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    WEWORK_USER_DATA_DIR: userData,
  }
  const logFile = join(userData, 'logs', 'wework-main.log')
  try {
    await Promise.all([mkdir(appData), mkdir(localAppData)])
    let preparationMs = null
    if (prepare) {
      const startedAt = performance.now()
      await execute(binary, [INSTALLED_PREPARATION_ARGUMENT], {
        env,
        timeout: 600_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
      preparationMs = Math.round(performance.now() - startedAt)
      const status = JSON.parse(
        await readFile(join(userData, 'logs', 'install-preparation.json'), 'utf8')
      )
      assert.equal(status.version, manifest.appVersion)
    }
    const firstLaunch = await launch(binary, env, logFile)
    if (prepare) {
      assert.equal(typeof firstLaunch.phaseDurationsMs['core-dsh-profile-reuse'], 'number')
    }
    const warmLaunch = await launch(binary, env, logFile)
    return { round, name, sourceSha: manifest.sourceSha, preparationMs, firstLaunch, warmLaunch }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

assert.equal(process.platform, 'win32')
await mkdir(dirname(output), { recursive: true })
for (const [round, order] of sampleOrders.entries()) {
  for (const index of order) {
    const sample = await measure(variants[index], round + 1)
    samples.push(sample)
    await writeFile(output, `${JSON.stringify({ shas, samples }, null, 2)}\n`)
    console.log(JSON.stringify(sample))
  }
}
