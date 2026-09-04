import { getRecognizedLink } from '@/lib/link-preview'
import { escapeComposerLinkLabel, escapeComposerLinkUrl } from './composerLinks'

export interface ComposerClipboardLike {
  getData(type: string): string | null | undefined
}

/**
 * Resolves the clipboard representation that should be pasted into the
 * composer. HTML wins when it carries recognizable anchors, because plain text
 * alone would lose the difference between a link's label and its href;
 * otherwise the plain text is used unchanged.
 */
export function composerClipboardText(clipboard: ComposerClipboardLike): string | undefined {
  const html = clipboard.getData('text/html')
  if (html) {
    const fromHtml = htmlClipboardToComposerText(html)
    if (fromHtml !== undefined) return fromHtml
  }
  return clipboard.getData('text/plain') || clipboard.getData('text') || undefined
}

const CLIPBOARD_BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
])

/**
 * Converts pasted HTML into composer text with anchor destinations preserved
 * as `[label](url)` markdown. Returns undefined when the HTML contains no
 * recognizable link so callers fall back to the plain-text clipboard, which
 * keeps ordinary pastes byte-for-byte identical to today.
 */
export function htmlClipboardToComposerText(html: string): string | undefined {
  let recognizedLinkCount = 0
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const text = clipboardNodeToText(parsed.body, () => {
    recognizedLinkCount += 1
  })
  if (recognizedLinkCount === 0) return undefined
  return normalizeClipboardText(text)
}

function clipboardNodeToText(node: Node, onRecognizedLink: () => void): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as HTMLElement
  const tag = element.tagName
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') return ''
  if (tag === 'BR') return '\n'
  if (tag === 'A') return clipboardAnchorText(element as HTMLAnchorElement, onRecognizedLink)

  let text = ''
  for (const child of element.childNodes) {
    text += clipboardNodeToText(child, onRecognizedLink)
  }
  if (CLIPBOARD_BLOCK_TAGS.has(tag)) text += '\n'
  return text
}

function clipboardAnchorText(anchor: HTMLAnchorElement, onRecognizedLink: () => void): string {
  const href = (anchor.getAttribute('href') ?? '').trim()
  const recognized = getRecognizedLink(href)
  if (!recognized) return anchor.textContent ?? ''
  onRecognizedLink()
  const label = collapseClipboardWhitespace(anchor.textContent ?? '') || recognized.url
  return `[${escapeComposerLinkLabel(label)}](${escapeComposerLinkUrl(recognized.url)})`
}

function collapseClipboardWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeClipboardText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Returns the pasted single recognized URL when the clipboard holds nothing
 * but one URL (plus optionally trailing prose punctuation). Used to decide
 * whether pasting over a selection should turn the selection into a link.
 */
export function singlePastedUrl(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return undefined
  const recognized = getRecognizedLink(trimmed)
  return recognized?.url
}

/**
 * Replaces the selected composer text with `[selected](pastedUrl)` so pasting
 * a URL over a selection wraps the selection instead of discarding it. Returns
 * undefined when the selection is empty, spans lines, or the clipboard does
 * not hold a single URL.
 */
export function wrapComposerSelectionWithPastedUrl({
  value,
  selectionStart,
  selectionEnd,
  pastedText,
}: {
  value: string
  selectionStart: number
  selectionEnd: number
  pastedText: string
}): { value: string; caretOffset: number } | undefined {
  if (selectionEnd <= selectionStart) return undefined
  const label = value.slice(selectionStart, selectionEnd)
  if (!label || /[\r\n]/.test(label)) return undefined
  const url = singlePastedUrl(pastedText)
  if (!url) return undefined
  const before = value.slice(0, selectionStart)
  const after = value.slice(selectionEnd)
  const serialized = `[${escapeComposerLinkLabel(label)}](${escapeComposerLinkUrl(url)})`
  return { value: `${before}${serialized}${after}`, caretOffset: before.length + serialized.length }
}
