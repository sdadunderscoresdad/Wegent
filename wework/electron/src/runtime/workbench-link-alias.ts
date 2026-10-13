import * as fs from 'node:fs'

/** How a migrated entry keeps its legacy path reachable. */
export type LinkAliasKind = 'symlink' | 'hard-link' | 'none'

/**
 * Links `path` to an existing `target`.
 *
 * Directories keep junctions on Windows, which needs no privilege. Windows only
 * grants symbolic links to elevated or Developer Mode accounts, so a file falls
 * back to a hard link, which any user can create on the same volume. `none`
 * means the legacy path stays unavailable; callers must keep running and report
 * it instead of blocking startup.
 */
export function createFileAlias(target: string, path: string): LinkAliasKind {
  try {
    fs.symlinkSync(target, path, 'file')
    return 'symlink'
  } catch (error) {
    if (!isLinkCapabilityError(error)) throw error
  }
  try {
    fs.linkSync(target, path)
    return 'hard-link'
  } catch {
    return 'none'
  }
}

function isLinkCapabilityError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS'
}
