import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** The executor reports fixed codes; anything else is treated as unverified. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const MAX_CODES = 8

const MESSAGES: Record<string, string> = {
  verification_failed: 'the credential storage check did not run',
  missing_home: 'the executor received no Codex Home to inspect',
  home_not_absolute: 'the Codex Home path is not absolute',
  encrypted_storage: 'encrypted credential files are bound to the current Codex Home path',
  cli_keyring_storage: 'login credentials use keyring storage bound to the current Codex Home path',
  enterprise_identity: 'enterprise identity credentials are bound to the current Codex Home path',
  home_metadata_unreadable: 'Codex Home metadata could not be inspected',
  config_unreadable: 'the Codex configuration could not be read',
  config_invalid: 'the Codex configuration could not be parsed',
  config_value_invalid: 'a Codex credential storage setting is invalid',
  encrypted_storage_unreadable: 'encrypted credential metadata could not be inspected',
}

/** Verdict for one Codex Home. A blocked Home keeps its current path. */
export interface CodexHomeMigrationVerdict {
  allowed: boolean
  reasons: string[]
  warnings: string[]
}

/**
 * Inspects whether the Codex Home may move. Never throws: the desktop keeps
 * starting with the Home at its current path when the check cannot verify it.
 */
export async function inspectCodexHomeMigration(
  command: string,
  home: string
): Promise<CodexHomeMigrationVerdict> {
  let response: unknown
  try {
    // --version makes older binaries exit without initializing any user data.
    const { stdout } = await execute(
      command,
      ['--workbench-codex-migration-check', home, '--version'],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      }
    )
    response = JSON.parse(stdout)
  } catch {
    return verificationFailed()
  }
  if (!response || typeof response !== 'object') return verificationFailed()
  const result = response as Record<string, unknown>
  if (result.codex_home_migration !== 1 || typeof result.allowed !== 'boolean') {
    return verificationFailed()
  }
  const reasons = migrationCodes(result.reasons)
  // A blocking verdict without a known reason is still a blocking verdict.
  if (result.allowed === false && reasons.length === 0) reasons.push('verification_failed')
  return {
    allowed: result.allowed === true && reasons.length === 0,
    reasons,
    warnings: migrationCodes(result.warnings),
  }
}

/** Maps executor codes to bounded text so a replaced binary cannot inject logs. */
export function describeCodexHomeMigrationVerdict(verdict: CodexHomeMigrationVerdict): string {
  return [
    ...verdict.reasons.map(code => `blocked: ${describe(code)}`),
    ...verdict.warnings.map(code => `warning: ${describe(code)}`),
  ].join('; ')
}

function describe(code: string): string {
  return MESSAGES[code] ?? 'the executor reported an unknown code'
}

function verificationFailed(): CodexHomeMigrationVerdict {
  return { allowed: false, reasons: ['verification_failed'], warnings: [] }
}

function migrationCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const codes = value.filter(
    (code): code is string => typeof code === 'string' && CODE_PATTERN.test(code)
  )
  return [...new Set(codes)].slice(0, MAX_CODES)
}
