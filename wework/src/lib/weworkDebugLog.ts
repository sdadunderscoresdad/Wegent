import { invoke } from '@tauri-apps/api/core'

const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)

export function weworkDebugLog(label: string, data: unknown): void {
  try {
    if (!isTauriRuntime()) {
      console.debug('[weworkDebug]', label, data)
      return
    }
    void invoke('write_debug_log', { label, data }).catch(() => {
      // Logging must never break the app.
    })
  } catch {
    // Ignore logging failures.
  }
}
