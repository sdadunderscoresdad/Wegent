import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { createFileAlias } from './workbench-link-alias.js'
import { preserveConflictPath, recordMigrationRepair } from './workbench-migration-repair.js'

interface EntryMigration {
  source: string
  target: string
  journal: string
}

interface Journal extends EntryMigration {
  version: 1
  device: string
  inode: string
  directory: boolean
  completed?: true
}

function stat(path: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function owns(path: string, journal: Journal): boolean {
  const entry = stat(path)
  return (
    !!entry &&
    (journal.directory ? entry.isDirectory() : entry.isFile()) &&
    entry.dev.toString() === journal.device &&
    entry.ino.toString() === journal.inode
  )
}

// A journal that cannot describe this entry is kept as evidence and replaced:
// stale migration state must never block startup.
function readJournal(options: EntryMigration): Journal | undefined {
  const entry = stat(options.journal)
  if (!entry) return undefined
  if (!entry.isFile()) {
    preserveJournal(options, 'not-a-file')
    return undefined
  }
  let journal: Partial<Journal> | null
  try {
    journal = JSON.parse(fs.readFileSync(options.journal, 'utf8')) as Partial<Journal>
  } catch {
    journal = null
  }
  if (
    journal?.version !== 1 ||
    journal.source !== options.source ||
    journal.target !== options.target ||
    journal.journal !== options.journal ||
    typeof journal.directory !== 'boolean' ||
    typeof journal.device !== 'string' ||
    typeof journal.inode !== 'string' ||
    !/^\d+$/.test(journal.device) ||
    !/^\d+$/.test(journal.inode) ||
    (journal.completed !== undefined && journal.completed !== true)
  ) {
    preserveJournal(options, 'invalid')
    return undefined
  }
  return journal as Journal
}

// Journal publications are atomic: a temporary hard link is renamed into place,
// so crash recovery never observes a partially written journal.
function writeJournal(options: EntryMigration, entry: fs.BigIntStats, completed = false): Journal {
  const journal: Journal = {
    ...options,
    version: 1,
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    directory: entry.isDirectory(),
    ...(completed && !entry.isDirectory() ? { completed: true as const } : {}),
  }
  fs.mkdirSync(dirname(options.journal), { recursive: true, mode: 0o700 })
  const temporary = `${options.journal}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
  fs.linkSync(temporary, options.journal)
  fs.unlinkSync(temporary)
  return journal
}

function preserveJournal(options: EntryMigration, reason: string): void {
  const preserved = `${options.journal}.${reason}-${Date.now().toString(36)}`
  fs.renameSync(options.journal, preserved)
  recordMigrationRepair(dirname(options.journal), {
    role: 'journal',
    path: options.journal,
    preserved,
    reason,
  })
  console.warn('[startup] migration-journal-discarded', {
    journal: options.journal,
    preserved,
    reason,
  })
}

// Conflicting data is renamed next to its original path and recorded, so both
// copies survive a reinstall, manual cleanup or antivirus interference.
function preserveConflict(
  options: EntryMigration,
  path: string,
  role: 'target' | 'legacy'
): string {
  const preserved = preserveConflictPath(path, role)
  recordMigrationRepair(dirname(options.journal), { role, path, preserved })
  return preserved
}

function bridge(options: EntryMigration, directory: boolean): void {
  if (directory) {
    fs.symlinkSync(options.target, options.source, 'junction')
    return
  }
  // A missing legacy alias must never block startup: on Windows a standard user
  // cannot create file symlinks, and the migrated entry stays available at its
  // new path either way.
  if (createFileAlias(options.target, options.source) === 'none') {
    console.warn('[startup] migration-legacy-alias-missing', {
      path: options.source,
      target: options.target,
    })
  }
}

function complete(journal: Journal): void {
  if (journal.directory || journal.completed) return
  const temporary = `${journal.journal}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ ...journal, completed: true }), {
    flag: 'wx',
    mode: 0o600,
  })
  fs.renameSync(temporary, journal.journal)
}

// Recover only the missing alias before Electron creates its single-instance files.
// The alias is exclusive: concurrent startup cannot overwrite an existing entry.
export function recoverWorkbenchDataBridge(options: EntryMigration): void {
  const journal = readJournal(options)
  if (
    !journal ||
    stat(options.source) ||
    (!owns(options.target, journal) && !(journal.completed && !journal.directory))
  )
    return
  try {
    bridge(options, journal.directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function preserveRelativeLinks(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) preserveRelativeLinks(path)
    else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(path)
      if (isAbsolute(target)) continue
      // Keep the original spelling, including '..' after symlink components.
      // The legacy directory alias keeps internal and external links valid.
      const temporary = `${path}.migration-${randomUUID()}`
      let directory = false
      try {
        directory = fs.statSync(path).isDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (directory) {
        fs.symlinkSync(
          `${dirname(path)}${sep}${target}`,
          temporary,
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      } else if (createFileAlias(`${dirname(path)}${sep}${target}`, temporary) === 'none') {
        console.warn('[startup] migration-relative-link-unavailable', { path })
        continue
      }
      fs.renameSync(temporary, path)
    }
  }
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return !suffix || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

function canonicalParent(path: string): string {
  const parent = dirname(path)
  if (parent === path) return fs.realpathSync(path)
  if (stat(parent)) return join(fs.realpathSync(parent), relative(parent, path))
  return join(canonicalParent(parent), relative(parent, path))
}

// Synchronous by design: userData/sessionData must move before Electron's ready event.
// Caller owns the app single-instance lock (or the executor migration lock).
// Rename preserves the complete SQLite/WAL/SHM set and credentials without copying.
//
// Migration state can be disturbed outside this process: a reinstall, a manual
// cleanup, an antivirus scanner, or an older build recreating an entry. The
// journal's device and inode identify the authoritative copy, and anything that
// no longer matches is kept next to its original path instead of blocking the
// desktop from starting.
export function migrateWorkbenchDataEntry(options: EntryMigration): void {
  const { source, target, journal: journalPath } = options
  const paths = [source, target, journalPath]
  if (paths.some(path => !isAbsolute(path)))
    throw new Error('Application data migration paths must be absolute')
  const [canonicalSource, canonicalTarget, canonicalJournal] = paths.map(path =>
    canonicalParent(resolve(path))
  )
  if (
    contains(canonicalSource, canonicalTarget) ||
    contains(canonicalTarget, canonicalSource) ||
    contains(canonicalSource, canonicalJournal) ||
    contains(canonicalTarget, canonicalJournal)
  ) {
    throw new Error('Application data migration paths must be absolute and disjoint')
  }
  let journal = readJournal(options)
  let original = stat(source)
  if (!journal) {
    if (!original) return
    if (!original.isDirectory() && !original.isFile()) {
      console.warn('[startup] migration-source-unavailable', { path: source })
      return
    }
    // Never merge two pre-existing entries: the unexpected target is kept aside.
    if (stat(target)) preserveConflict(options, target, 'target')
    journal = writeJournal(options, original)
  }
  if (original?.isSymbolicLink()) {
    const destination = stat(target)
    if (
      journal.directory
        ? destination?.isDirectory() &&
          destination.ino.toString() === journal.inode &&
          fs.realpathSync(source) === fs.realpathSync(target)
        : resolve(dirname(source), fs.readlinkSync(source)) === resolve(target)
    ) {
      // A published bridge identifies its destination even when st_dev changes
      // after a remount. Keep the directory inode check; files may be atomically
      // replaced or removed by SQLite.
      complete(journal)
      return
    }
    // A link that no longer identifies the migrated entry is kept aside.
    preserveConflict(options, source, 'legacy')
    original = stat(source)
  }
  // SQLite may remove both an old sidecar alias and its migrated destination.
  // Only a previously published file alias can be recreated without the inode.
  if (!original && journal.completed && !journal.directory) {
    bridge(options, false)
    return
  }
  if (owns(target, journal)) {
    // The move happened; a legacy entry written afterwards stays recoverable.
    if (original) preserveConflict(options, source, 'legacy')
    bridge(options, journal.directory)
    complete(journal)
    return
  }
  if (!original) {
    const surviving = stat(target)
    if (!surviving) {
      console.warn('[startup] migration-entry-missing', { source, target })
      return
    }
    // The migrated copy was replaced; adopt the current layout and re-anchor the
    // journal so later launches stay idempotent.
    preserveJournal(options, 'stale')
    writeJournal(options, surviving, true)
    bridge(options, surviving.isDirectory())
    return
  }
  if (!owns(source, journal)) {
    // The legacy entry was replaced or recreated: adopt it as the migration
    // source and keep the replaced journal and target as evidence.
    preserveJournal(options, 'stale')
    if (stat(target)) preserveConflict(options, target, 'target')
    journal = writeJournal(options, original)
  } else if (stat(target)) {
    // Both sides exist: the unexpected target cannot be merged, so it is kept.
    preserveConflict(options, target, 'target')
  }
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (journal.directory) preserveRelativeLinks(source)
  fs.renameSync(source, target)
  bridge(options, journal.directory)
  complete(journal)
}
