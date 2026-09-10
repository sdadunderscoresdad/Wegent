import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveDevUserDataDirectory } from './resolve-dev-user-data.mjs'

describe('resolveDevUserDataDirectory', () => {
  test('isolates the default user data directory by worktree', () => {
    const homeDirectory = '/Users/example'
    const first = resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory, 'darwin')
    const repeated = resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory, 'darwin')
    const second = resolveDevUserDataDirectory('/worktrees/second', '', homeDirectory, 'darwin')
    const root = join(homeDirectory, 'Library', 'Application Support', 'io.wecode.wework.dev')

    expect(first).toBe(repeated)
    expect(first).not.toBe(second)
    expect(first.startsWith(root)).toBe(true)
    expect(second.startsWith(root)).toBe(true)
  })

  test('preserves an explicit user data directory override', () => {
    expect(
      resolveDevUserDataDirectory('/worktrees/first', './custom-user-data', '/Users/example')
    ).toBe(resolve('./custom-user-data'))
  })

  test('uses the platform application-data directory', () => {
    const environment = {
      APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
      XDG_CONFIG_HOME: '/home/example/.config',
    }
    const windows = resolveDevUserDataDirectory(
      String.raw`D:\worktrees\first`,
      '',
      String.raw`C:\Users\example`,
      'win32',
      environment
    )
    const linux = resolveDevUserDataDirectory(
      '/home/example/worktrees/first',
      '',
      '/home/example',
      'linux',
      environment
    )
    const root = 'io.wecode.wework.dev'

    expect(windows.startsWith(join(environment.APPDATA, root))).toBe(true)
    expect(windows).toMatch(/[a-f0-9]{16}$/)
    expect(linux.startsWith(join(environment.XDG_CONFIG_HOME, root))).toBe(true)
    expect(linux).toMatch(/[a-f0-9]{16}$/)
  })

  test('reuses the legacy worktree directory to preserve desktop identity', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'wework-dev-user-data-'))
    try {
      const current = resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory)
      const legacy = join(dirname(current), basename(current).slice(0, 12))
      await mkdir(current, { recursive: true })
      await mkdir(legacy, { recursive: true })

      expect(resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory)).toBe(legacy)
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })

  test('reuses the macOS-style worktree directory written before the platform default', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'wework-dev-user-data-'))
    try {
      const worktreeHash = createHash('sha256').update(resolve('/worktrees/first')).digest('hex')
      const legacy = join(
        homeDirectory,
        'Library',
        'Application Support',
        'io.wecode.wework.dev',
        worktreeHash.slice(0, 16)
      )
      await mkdir(legacy, { recursive: true })

      expect(
        resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory, 'win32', {
          APPDATA: join(homeDirectory, 'AppData', 'Roaming'),
        })
      ).toBe(legacy)
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })
})
