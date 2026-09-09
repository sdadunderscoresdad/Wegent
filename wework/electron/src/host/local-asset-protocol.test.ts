import { beforeEach, describe, expect, test, vi } from 'vitest'

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
const { protocol } = vi.hoisted(() => ({
  protocol: { handle: vi.fn() },
}))

vi.mock('electron', () => ({ protocol }))
vi.mock('node:fs/promises', () => ({ readFile }))

describe('local asset protocol', () => {
  beforeEach(() => {
    readFile.mockReset()
    protocol.handle.mockReset()
  })

  test('serves supported local images', async () => {
    const { installLocalAssetProtocol } = await import('./local-asset-protocol.js')
    let handler: (request: Request) => Promise<Response>
    protocol.handle.mockImplementationOnce((_scheme, implementation) => {
      handler = implementation
    })
    readFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3]))

    installLocalAssetProtocol()
    const response = await handler(
      new Request('asset://localhost/tmp/wework/background%20image.png')
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer)
    expect(readFile).toHaveBeenCalledWith('/tmp/wework/background image.png')
  })

  test('rejects unsupported files and malformed URLs', async () => {
    const { installLocalAssetProtocol } = await import('./local-asset-protocol.js')
    let handler: (request: Request) => Promise<Response>
    protocol.handle.mockImplementationOnce((_scheme, implementation) => {
      handler = implementation
    })

    installLocalAssetProtocol()
    const response = await handler(new Request('asset://localhost/etc/passwd'))

    expect(response.status).toBe(404)
    expect(readFile).not.toHaveBeenCalled()
  })

  test('accepts Windows drive paths', async () => {
    const { installLocalAssetProtocol } = await import('./local-asset-protocol.js')
    let handler: (request: Request) => Promise<Response>
    protocol.handle.mockImplementationOnce((_scheme, implementation) => {
      handler = implementation
    })
    readFile.mockResolvedValueOnce(new Uint8Array([4, 5]))

    installLocalAssetProtocol()
    const response = await handler(new Request('asset://localhost/C%3A/Users/me/image.webp'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(readFile).toHaveBeenCalledWith('C:/Users/me/image.webp')
  })
})
