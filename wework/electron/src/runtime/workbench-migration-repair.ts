import * as fs from 'node:fs'
import { join } from 'node:path'

/** Which side of a migration a preserved path used to be. */
export type MigrationRepairRole = 'target' | 'legacy' | 'journal'

export interface MigrationRepair {
  role: MigrationRepairRole
  path: string
  preserved: string
  reason?: string
}

const REPAIRS_FILE = 'conflict-repairs.jsonl'

/**
 * Keeps conflicting data next to its original path.
 *
 * Migration state can be disturbed outside this process, and neither side of a
 * conflict may be deleted: the entry is renamed so both copies survive and the
 * caller reports the repair.
 */
export function preserveConflictPath(path: string, role: 'target' | 'legacy'): string {
  const base = `${path}.${role}-conflict-${Date.now().toString(36)}`
  let preserved = base
  let index = 1
  while (fs.existsSync(preserved)) {
    preserved = `${base}-${index}`
    index += 1
  }
  fs.renameSync(path, preserved)
  console.warn('[startup] migration-conflict-repaired', { path, preserved, role })
  return preserved
}

/** Appends one repair record so the next startup and support can trace it. */
export function recordMigrationRepair(directory: string, repair: MigrationRepair): void {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.appendFileSync(
      join(directory, REPAIRS_FILE),
      `${JSON.stringify({ at: new Date().toISOString(), ...repair })}\n`,
      { mode: 0o600 }
    )
  } catch (error) {
    console.warn('[startup] migration-repair-record-failed', {
      path: repair.path,
      code: (error as NodeJS.ErrnoException).code,
    })
  }
}
