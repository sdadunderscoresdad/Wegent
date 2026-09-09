import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resetFaviconProbeCache, resolveFavicon } from '@/lib/favicon-resolver'
import {
  applyLinkIcon,
  escapeComposerLinkLabel,
  escapeComposerLinkUrl,
  parseComposerLinks,
  type ComposerLinkPayload,
} from './composerLinks'
import { createComposerDocument, serializeComposerDocument } from './composerProseMirrorModel'

vi.mock('@/lib/favicon-resolver', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/favicon-resolver')>('@/lib/favicon-resolver')
  return { ...actual, resolveFavicon: vi.fn(async () => undefined) }
})

let resolveImageOnLoad = false
class MockImage {
  onload: (() => void) | null = null
  set src(value: string) {
    // jsdom never loads images; only resolve the probe when the test opts in.
    if (resolveImageOnLoad) this.onload?.()
  }
}

const webLink = (url: string): ComposerLinkPayload => ({ url, label: url, provider: 'web' })

function mountIcon(): HTMLImageElement {
  const icon = document.createElement('img')
  document.body.appendChild(icon)
  return icon
}

beforeEach(() => {
  resolveImageOnLoad = false
  resetFaviconProbeCache()
  vi.mocked(resolveFavicon).mockReset()
  vi.mocked(resolveFavicon).mockResolvedValue(undefined)
  vi.stubGlobal('Image', MockImage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('applyLinkIcon', () => {
  test('applies the backend favicon when the URL is unchanged', async () => {
    resolveImageOnLoad = true
    vi.mocked(resolveFavicon).mockResolvedValue('https://cdn.example.com/icon.png')
    const icon = mountIcon()

    applyLinkIcon(icon, webLink('https://example.com/page'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(icon.src).toBe('https://cdn.example.com/icon.png')
  })

  test('ignores a stale favicon resolution after the link URL changes', async () => {
    resolveImageOnLoad = true
    let resolveA: (value: string | undefined) => void
    const promiseA = new Promise<string | undefined>(resolve => {
      resolveA = resolve
    })
    vi.mocked(resolveFavicon)
      .mockReturnValueOnce(promiseA)
      .mockResolvedValueOnce('https://cdn.example.com/icon-b.png')
    const icon = mountIcon()

    applyLinkIcon(icon, webLink('https://example.com/a'))
    applyLinkIcon(icon, webLink('https://example.com/b'))
    resolveA!('https://cdn.example.com/icon-a.png')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(resolveFavicon).toHaveBeenCalledWith('https://example.com/b')
    expect(icon.src).toBe('https://cdn.example.com/icon-b.png')
  })
})

describe('Codex-style markdown link scanning', () => {
  test('keeps the full URL when the destination contains balanced parentheses', () => {
    const value = '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'
    const links = parseComposerLinks(value)
    expect(links).toHaveLength(1)
    expect(links[0]?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(links[0]?.label).toBe('wiki')
    expect(serializeComposerDocument(createComposerDocument(value))).toBe(
      '[wiki](https://en.wikipedia.org/wiki/Foo_\\(bar\\))'
    )
  })

  test('round-trips a URL whose destination ends with a closing parenthesis', () => {
    const serialized = '[x](https://example.com/a_\\(b\\))'
    const links = parseComposerLinks(serialized)
    expect(links).toHaveLength(1)
    expect(links[0]?.url).toBe('https://example.com/a_(b)')
    expect(serializeComposerDocument(createComposerDocument(serialized))).toBe(serialized)
  })

  test('parses escaped brackets in the label and round-trips them', () => {
    const value = '[a\\]b](https://example.com/x)'
    const links = parseComposerLinks(value)
    expect(links).toHaveLength(1)
    expect(links[0]?.label).toBe('a]b')
    expect(links[0]?.url).toBe('https://example.com/x')
    expect(serializeComposerDocument(createComposerDocument(value))).toBe(value)
  })

  test('leaves an unbalanced destination as plain text', () => {
    expect(parseComposerLinks('[x](https://example.com/a(b)')).toHaveLength(0)
  })

  test('does not span line breaks', () => {
    expect(
      parseComposerLinks('a [x](https://example.com/1)\nb [y](https://example.com/2)').map(
        link => link.url
      )
    ).toEqual(['https://example.com/1', 'https://example.com/2'])
    expect(parseComposerLinks('[a\nb](https://example.com/x)')).toHaveLength(0)
  })

  test('escapes labels and URLs for serialization', () => {
    expect(escapeComposerLinkLabel('a]b\\c')).toBe('a\\]b\\\\c')
    expect(escapeComposerLinkUrl('https://example.com/a_(b)')).toBe('https://example.com/a_\\(b\\)')
  })
})
