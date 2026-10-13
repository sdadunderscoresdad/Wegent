import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import {
  describeCodexHomeMigrationVerdict,
  inspectCodexHomeMigration,
} from './workbench-codex-migration.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: (
      command: string,
      args: string[],
      options: import('node:child_process').ExecFileOptions
    ) =>
      promisify(original.execFile)(process.execPath, [command, ...args], {
        ...options,
        // Sandboxes that run Vitest through Electron-as-Node need the flag in the
        // child environment; the real executor is a native binary.
        env: { ...options?.env, ELECTRON_RUN_AS_NODE: '1' },
      }),
  })
  return { ...original, execFile }
})

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex move check '))
  directories.push(root)
  return { root, script: join(root, 'probe.cjs'), home: join(root, 'codex home') }
}

test('inspects the exact Home without forwarding credentials or accepting legacy output', async () => {
  const { script, home } = await fixture()
  await writeFile(
    script,
    `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['--workbench-codex-migration-check', home, '--version']))}) process.exit(2)
    if (process.env.WEGENT_AUTH_TOKEN || process.env.CODEX_HOME) process.exit(3)
    process.stdout.write(JSON.stringify({codex_home_migration: 1, allowed: true, reasons: [], warnings: []}))
  `
  )
  vi.stubEnv('WEGENT_AUTH_TOKEN', 'synthetic-not-forwarded')
  vi.stubEnv('CODEX_HOME', '/must-not-inherit')
  await expect(inspectCodexHomeMigration(script, home)).resolves.toEqual({
    allowed: true,
    reasons: [],
    warnings: [],
  })
})

test('reports blocking evidence and warnings as bounded codes', async () => {
  const { script, home } = await fixture()
  await writeFile(
    script,
    `process.stdout.write(${JSON.stringify(
      JSON.stringify({
        codex_home_migration: 1,
        allowed: false,
        reasons: ['encrypted_storage', 'encrypted_storage', 'not a code', 42],
        warnings: ['config_invalid'],
        reason: 'synthetic-credential-value',
      })
    )})`
  )
  const verdict = await inspectCodexHomeMigration(script, home)
  expect(verdict).toEqual({
    allowed: false,
    reasons: ['encrypted_storage'],
    warnings: ['config_invalid'],
  })
  const detail = describeCodexHomeMigrationVerdict(verdict)
  expect(detail).toContain('encrypted credential files')
  expect(detail).toContain('could not be parsed')
  expect(detail).not.toContain('synthetic-credential-value')
  expect(
    describeCodexHomeMigrationVerdict({ allowed: false, reasons: ['mystery_code'], warnings: [] })
  ).not.toContain('mystery_code')
  // A blocking verdict without a usable reason still keeps the Home in place.
  await writeFile(
    script,
    `process.stdout.write(${JSON.stringify(
      JSON.stringify({ codex_home_migration: 1, allowed: false, reasons: [], warnings: [] })
    )})`
  )
  await expect(inspectCodexHomeMigration(script, home)).resolves.toEqual({
    allowed: false,
    reasons: ['verification_failed'],
    warnings: [],
  })
})

test('keeps an unverified Home in place instead of failing startup', async () => {
  const { root, script, home } = await fixture()
  for (const response of [
    null,
    {},
    { codex_home_migration: 2, allowed: true },
    { codex_home_migration: 1 },
  ]) {
    await writeFile(script, `process.stdout.write(${JSON.stringify(JSON.stringify(response))})`)
    await expect(inspectCodexHomeMigration(script, home)).resolves.toEqual({
      allowed: false,
      reasons: ['verification_failed'],
      warnings: [],
    })
  }
  await writeFile(script, "process.stdout.write('executor 0.0.1')")
  await expect(inspectCodexHomeMigration(script, home)).resolves.toEqual({
    allowed: false,
    reasons: ['verification_failed'],
    warnings: [],
  })
  await expect(inspectCodexHomeMigration(join(root, 'missing-executor'), home)).resolves.toEqual({
    allowed: false,
    reasons: ['verification_failed'],
    warnings: [],
  })
})
