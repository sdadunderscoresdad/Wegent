import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  applyBrandRuntimeEnvironment,
  type BrandRuntimeMetadata,
} from './brand-runtime-environment.js'
import { migrateWorkbenchHome } from './workbench-home-migration.js'
import { assertExecutorWorkbenchCompatibility } from './workbench-executor-schema.js'
import {
  describeCodexHomeMigrationVerdict,
  inspectCodexHomeMigration,
} from './workbench-codex-migration.js'
import { executorMigrationLock } from './workbench-migration-lock.js'
import { migrateWorkbenchDataInWorker } from './workbench-data-worker.js'

interface WorkbenchEnvironmentOptions {
  environment: NodeJS.ProcessEnv
  metadata: BrandRuntimeMetadata
  homeDirectory: string
}

export interface WorkbenchPaths {
  root: string
  shared: string
  agents: string
  desktop: string
  codexHome: string
  claudeHome: string
  capabilities: string
  migrations: string
}

/**
 * Runs one Home migration and reports whether the new layout is authoritative.
 *
 * Migration state on disk can be inconsistent (a reinstall, manual cleanup, or
 * antivirus interference). Starting the desktop with the legacy path is always
 * better than refusing to start, so any failure keeps that Home in place and is
 * reported; the next launch retries.
 */
async function keepLegacyHomeOnFailure(
  home: string,
  migrate: () => Promise<boolean>
): Promise<boolean> {
  try {
    return await migrate()
  } catch (error) {
    console.warn('[startup] home-migration-skipped', {
      home,
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

function resolveWorkbenchUserHome(options: WorkbenchEnvironmentOptions): string {
  // macOS Electron getPath('home') ignores HOME, unlike the executor child.
  const home =
    options.environment.HOME?.trim() ||
    options.environment.USERPROFILE?.trim() ||
    options.homeDirectory
  if (!isAbsolute(home)) throw new Error('Workbench user Home must be an absolute path')
  return resolve(home)
}

export function resolveWorkbenchPaths(options: WorkbenchEnvironmentOptions): WorkbenchPaths {
  const configuredRoot = options.environment.WEGENT_WORKBENCH_HOME?.trim()
  if (configuredRoot && !isAbsolute(configuredRoot)) {
    throw new Error('WEGENT_WORKBENCH_HOME must be an absolute path')
  }
  const namespace = options.metadata.weworkExecutorNamespace?.trim() || 'default'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(namespace)) {
    throw new Error('Invalid Workbench application namespace')
  }
  const root = resolve(
    configuredRoot || join(resolveWorkbenchUserHome(options), '.wegent', 'workbench')
  )
  const desktop = join(root, 'wework', namespace)
  return {
    root,
    shared: join(root, 'shared'),
    agents: join(root, 'agents'),
    desktop,
    codexHome: join(desktop, 'codex'),
    claudeHome: join(desktop, 'claude'),
    capabilities: join(desktop, 'capabilities'),
    migrations: join(desktop, 'migrations'),
  }
}

// Call before starting the managed executor, never while its Home is in use.
export async function prepareWorkbenchEnvironment(
  options: WorkbenchEnvironmentOptions
): Promise<NodeJS.ProcessEnv> {
  const { environment, metadata } = options
  const homeDirectory = resolveWorkbenchUserHome(options)
  const branded = applyBrandRuntimeEnvironment(environment, metadata, homeDirectory)

  const paths = resolveWorkbenchPaths(options)
  const defaultExecutorHome = metadata.weworkExecutorNamespace?.trim()
    ? join(homeDirectory, '.wework', 'apps', metadata.weworkExecutorNamespace.trim())
    : join(homeDirectory, '.wework')
  const executorHome = branded.WEGENT_EXECUTOR_HOME?.trim() || defaultExecutorHome
  if (resolve(executorHome) !== resolve(defaultExecutorHome)) return branded
  if (
    ![
      'WORKSPACE_ROOT',
      'WEGENT_WORKSPACE_ROOT',
      'LOCAL_WORKSPACE_ROOT',
      'WEGENT_EXECUTOR_PROJECTS_DIR',
    ].some(key => environment[key]?.trim())
  ) {
    branded.WORKSPACE_ROOT = join(homeDirectory, '.wegent', 'workspace')
  }

  await assertExecutorWorkbenchCompatibility(branded)
  const acquireLock = executorMigrationLock(branded.WEWORK_EXECUTOR_PATH!)
  const legacyCodexHome = join(executorHome, 'codex')
  let codexHome = paths.codexHome
  if (!environment.WEGENT_CODEX_HOME?.trim()) {
    const migrated = await keepLegacyHomeOnFailure('codex', async () => {
      const result = await migrateWorkbenchHome({
        acquireLock,
        sourceHome: legacyCodexHome,
        targetHome: paths.codexHome,
        stateDirectory: join(paths.migrations, 'codex-home-v1'),
        initialize: true,
        beforeMove: async home => {
          const verdict = await inspectCodexHomeMigration(branded.WEWORK_EXECUTOR_PATH!, home)
          // A Home-bound credential store keeps its current path: moving it would
          // strand the keyring identity, while refusing to start would strand the
          // whole desktop. The next launch retries once the evidence is gone.
          if (!verdict.allowed) {
            console.warn('[startup] codex-home-migration-skipped', {
              home,
              detail: describeCodexHomeMigrationVerdict(verdict),
            })
            return 'skip'
          }
          if (verdict.warnings.length > 0) {
            console.warn('[startup] codex-home-migration-warnings', {
              home,
              detail: describeCodexHomeMigrationVerdict(verdict),
            })
          }
          return 'move'
        },
      })
      return result !== 'skipped'
    })
    if (!migrated) codexHome = legacyCodexHome
  }
  const legacyCapabilitiesHome = join(executorHome, 'capabilities')
  let capabilitiesHome = paths.capabilities
  if (!environment.WEGENT_CAPABILITIES_HOME?.trim()) {
    const migrated = await keepLegacyHomeOnFailure('capabilities', async () => {
      await migrateWorkbenchHome({
        acquireLock,
        sourceHome: legacyCapabilitiesHome,
        targetHome: paths.capabilities,
        stateDirectory: join(paths.migrations, 'capabilities-v1'),
        initialize: true,
      })
      return true
    })
    if (!migrated) capabilitiesHome = legacyCapabilitiesHome
  }
  const customClaudeHome =
    environment.WEGENT_CLAUDE_HOME?.trim() || environment.CLAUDE_CONFIG_DIR?.trim()
  let claudeHome = customClaudeHome || paths.claudeHome
  if (!customClaudeHome) {
    const legacyClaudeHome = join(executorHome, 'claude')
    const migrated = await keepLegacyHomeOnFailure('claude', async () => {
      // The user's ~/.claude is not owned by Wework and must never be relocated.
      await migrateWorkbenchHome({
        acquireLock,
        sourceHome: legacyClaudeHome,
        targetHome: paths.claudeHome,
        stateDirectory: join(paths.migrations, 'claude-home-v1'),
        initialize: true,
        preserveExistingSource: true,
      })
      await migrateWorkbenchHome({
        acquireLock,
        sourceHome: legacyClaudeHome,
        targetHome: paths.claudeHome,
        stateDirectory: join(paths.migrations, 'claude-home-v1'),
      })
      // Claude hashes the lexical CLAUDE_CONFIG_DIR for Keychain service identity.
      // Keep its lexical spelling while physically relocating the backing data.
      const journal = JSON.parse(
        await readFile(
          join(paths.migrations, 'claude-home-v1', 'workbench-home-migration.json'),
          'utf8'
        )
      )
      if (journal.strategy === 'relocate-source') claudeHome = legacyClaudeHome
      return true
    })
    if (!migrated) claudeHome = legacyClaudeHome
  }
  const lock = await acquireLock([executorHome, paths.desktop])
  try {
    lock.assertHeld()
    await migrateWorkbenchDataInWorker({
      source: executorHome,
      target: paths.desktop,
      state: paths.migrations,
    })
    lock.assertHeld()
  } finally {
    await lock.release()
  }
  return {
    ...branded,
    WEGENT_EXECUTOR_HOME: paths.desktop,
    WEGENT_WORKBENCH_HOME: paths.root,
    WEGENT_CODEX_HOME: environment.WEGENT_CODEX_HOME?.trim() || codexHome,
    WEGENT_CAPABILITIES_HOME: environment.WEGENT_CAPABILITIES_HOME?.trim() || capabilitiesHome,
    WEGENT_CLAUDE_HOME: claudeHome,
  }
}
