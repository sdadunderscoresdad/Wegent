import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const userDataDirectoryName = 'io.wecode.wework.dev'

function platformUserDataRoot(homeDirectory, platform, environment) {
  if (platform === 'win32') {
    const appData = environment.APPDATA?.trim() || join(homeDirectory, 'AppData', 'Roaming')
    return join(appData, userDataDirectoryName)
  }
  if (platform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', userDataDirectoryName)
  }
  const configHome = environment.XDG_CONFIG_HOME?.trim() || join(homeDirectory, '.config')
  return join(configHome, userDataDirectoryName)
}

function userDataRoots(homeDirectory, platform, environment) {
  const currentRoot = platformUserDataRoot(homeDirectory, platform, environment)
  // Launchers before the platform-aware default wrote the macOS-style root on every
  // platform; those directories own the persisted desktop identity.
  const legacyRoot = join(homeDirectory, 'Library', 'Application Support', userDataDirectoryName)
  return currentRoot === legacyRoot ? [currentRoot] : [legacyRoot, currentRoot]
}

function existingUserDataDirectory(roots, worktreeHash) {
  // Older launchers truncated the worktree hash to 12 characters.
  for (const root of roots) {
    for (const prefixLength of [12, 16]) {
      const directory = join(root, worktreeHash.slice(0, prefixLength))
      if (existsSync(directory)) return directory
    }
  }
  return null
}

export function resolveDevUserDataDirectory(
  projectDirectory,
  configuredDirectory = '',
  homeDirectory = homedir(),
  platform = process.platform,
  environment = process.env
) {
  const configured = configuredDirectory.trim()
  if (configured) return resolve(configured)

  const worktreeHash = createHash('sha256').update(resolve(projectDirectory)).digest('hex')
  const roots = userDataRoots(homeDirectory, platform, environment)
  return (
    existingUserDataDirectory(roots, worktreeHash) ??
    join(roots[roots.length - 1], worktreeHash.slice(0, 16))
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectDirectory = process.argv[2]
  if (!projectDirectory) {
    console.error(
      'Usage: node resolve-dev-user-data.mjs <project-directory> [configured-directory]'
    )
    process.exit(1)
  }

  process.stdout.write(resolveDevUserDataDirectory(projectDirectory, process.argv[3] ?? ''))
}
