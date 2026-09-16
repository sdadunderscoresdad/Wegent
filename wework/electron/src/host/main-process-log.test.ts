import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { MainProcessLog, type MainProcessOutputStream } from './main-process-log.js'

function createStream(): MainProcessOutputStream & { chunks: string[] } {
  const chunks: string[] = []
  return {
    chunks,
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    },
  }
}

async function createLog(): Promise<{
  log: MainProcessLog
  stdout: MainProcessOutputStream & { chunks: string[] }
  stderr: MainProcessOutputStream & { chunks: string[] }
  path: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'wework-main-process-log-'))
  const path = join(directory, 'app.log')
  const log = new MainProcessLog()
  const stdout = createStream()
  const stderr = createStream()
  log.install(stdout, stderr)
  log.persistTo(path)
  return { log, stdout, stderr, path }
}

test('records stdout and stderr while forwarding to the original streams', async () => {
  const { log, stdout, stderr, path } = await createLog()

  stdout.write('startup step one\n')
  stderr.write('startup step two\n')
  await log.flush()

  const contents = await readFile(path, 'utf8')
  expect(contents).toContain('[stdout] startup step one')
  expect(contents).toContain('[stderr] startup step two')
  expect(stdout.chunks).toEqual(['startup step one\n'])
  expect(stderr.chunks).toEqual(['startup step two\n'])
})

test('keeps output printed before the log directory is known', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-main-process-log-early-'))
  const path = join(directory, 'app.log')
  const log = new MainProcessLog()
  const stdout = createStream()
  log.install(stdout, createStream())

  stdout.write('printed before the desktop log directory was resolved\n')
  log.persistTo(path)
  await log.flush()

  expect(await readFile(path, 'utf8')).toContain(
    'printed before the desktop log directory was resolved'
  )
})

test('redacts credentials', async () => {
  const { log, stdout, path } = await createLog()

  stdout.write('Authorization: Bearer header-value api_key=query-value\n')
  await log.flush()

  const contents = await readFile(path, 'utf8')
  expect(contents).not.toContain('header-value')
  expect(contents).not.toContain('query-value')
  expect(contents).toContain('[REDACTED]')
})

test('flushes a trailing line without a newline', async () => {
  const { log, stdout, path } = await createLog()

  stdout.write('startup failed without a trailing newline')
  await log.flush()

  expect(await readFile(path, 'utf8')).toContain('startup failed without a trailing newline')
})

test('bounds buffered lines before the log directory is known', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-main-process-log-cap-'))
  const path = join(directory, 'app.log')
  const log = new MainProcessLog()
  const stdout = createStream()
  log.install(stdout, createStream())

  stdout.write(`${Array.from({ length: 2500 }, (_, index) => `line ${index}`).join('\n')}\n`)
  log.persistTo(path)
  await log.flush()

  const contents = await readFile(path, 'utf8')
  expect(contents).toContain('dropped 500 buffered lines')
  expect(contents).toContain('line 2499')
  expect(contents).not.toContain('line 499\n')
})

test('stops recording when the log file cannot be written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-main-process-log-failure-'))
  const blockingFile = join(directory, 'blocking-file')
  await writeFile(blockingFile, 'not a directory\n')
  const log = new MainProcessLog()
  const stdout = createStream()
  log.install(stdout, createStream())

  log.persistTo(join(blockingFile, 'app.log'))
  stdout.write('stdout stays usable after a log failure\n')
  await expect(log.flush()).resolves.toBeUndefined()

  expect(stdout.chunks).toEqual(['stdout stays usable after a log failure\n'])
})
