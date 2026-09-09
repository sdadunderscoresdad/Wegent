import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  backgroundImageUrl,
  removeWorkbenchBackground,
  selectWorkbenchBackground,
} from './backgroundImage'

const { invokeDesktopHost } = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
}))
const { isElectronRuntime } = vi.hoisted(() => ({ isElectronRuntime: vi.fn() }))

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime }))

describe('workbench background image service', () => {
  beforeEach(() => {
    invokeDesktopHost.mockReset()
    isElectronRuntime.mockReturnValue(true)
  })

  test('returns the selected Electron desktop file', async () => {
    invokeDesktopHost.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/source.png'],
    })

    await expect(selectWorkbenchBackground('dark')).resolves.toBe('/tmp/source.png')
    expect(invokeDesktopHost).toHaveBeenCalledWith('dialog.open', {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    })
  })

  test('does not import when the picker is cancelled', async () => {
    invokeDesktopHost.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(selectWorkbenchBackground('light')).resolves.toBeNull()
  })

  test('removes the configured image and converts its desktop display URL', async () => {
    await removeWorkbenchBackground('light')

    expect(invokeDesktopHost).not.toHaveBeenCalled()
    expect(backgroundImageUrl('/app-data/background.webp')).toBe(
      'asset://localhost/app-data/background.webp'
    )
    expect(backgroundImageUrl('C:\\Users\\me\\背景.webp')).toBe(
      'asset://localhost/C%3A/Users/me/%E8%83%8C%E6%99%AF.webp'
    )
  })
})
