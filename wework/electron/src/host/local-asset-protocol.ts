import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { protocol } from 'electron'

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export function installLocalAssetProtocol(): void {
  protocol.handle('asset', async request => {
    try {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]):(?=\/)/, '$1:')
      const contentType = MIME_TYPES[extname(path).toLowerCase()]
      if (
        url.hostname !== 'localhost' ||
        url.search ||
        url.hash ||
        !contentType ||
        !(path.startsWith('/') || /^[a-zA-Z]:\//.test(path))
      ) {
        return new Response(null, { status: 404 })
      }
      return new Response(await readFile(path), { headers: { 'content-type': contentType } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
