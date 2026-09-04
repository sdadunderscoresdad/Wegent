import { GENERIC_LINK_ICON_SRC, resolveAndProbeIcon, resolveFavicon } from '@/lib/favicon-resolver'
import {
  BARE_HTTP_URL_REGEX,
  getRecognizedLink,
  trimUrlBoundaries,
  type RecognizedLink,
} from '@/lib/link-preview'

export interface ComposerLinkPayload {
  url: string
  label: string
  iconUrl: string
  provider: string
}

export interface ParsedComposerLink extends ComposerLinkPayload {
  start: number
  end: number
}

/**
 * Escapes a link label for serialization inside `[label](url)`. A label that
 * contains `]` or `\` would otherwise end the markdown token early, so those
 * characters are backslash-escaped like Codex's link serializer does.
 */
export function escapeComposerLinkLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll(']', '\\]')
}

/**
 * Escapes a link URL for serialization inside `[label](url)`. Parens are
 * backslash-escaped so the balanced-parenthesis destination scanner never
 * mistakes part of the URL for the token delimiter; the matching delimiter is
 * appended after the escaped destination.
 */
export function escapeComposerLinkUrl(url: string): string {
  return url.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

/**
 * Unescapes backslash-escaped punctuation (`\]`, `\\)`, `\(` ...) captured by
 * {@link scanMarkdownComposerLinks}. Mirrors the escaping above so labels and
 * URLs round-trip through `[label](url)` unchanged.
 */
export function unescapeComposerLinkText(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

export interface ScannedComposerLink {
  start: number
  end: number
  /** Raw label text between the brackets, still backslash-escaped. */
  label: string
  /** Raw destination text between the parentheses, still backslash-escaped. */
  url: string
}

/**
 * Scans `[label](url)` tokens like Codex's character-level link scanner:
 * labels may contain escaped `\]`/`\\`, destinations may contain escaped
 * characters and balanced parentheses, and neither side may span a line
 * break. Unescaped `)` ends the destination (or `(`/`)` pairs stay inside it
 * like CommonMark's balanced-parentheses rule).
 */
export function scanMarkdownComposerLinks(value: string): ScannedComposerLink[] {
  const links: ScannedComposerLink[] = []
  let searchFrom = 0
  while (searchFrom < value.length) {
    const open = value.indexOf('[', searchFrom)
    if (open === -1) break
    let cursor = open + 1
    let labelEnd = -1
    let restartFrom = -1
    while (cursor < value.length) {
      const char = value[cursor]
      if (char === '\n' || char === '\r') {
        restartFrom = cursor + 1
        break
      }
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === ']') {
        labelEnd = cursor
        break
      }
      cursor += 1
    }
    if (restartFrom !== -1) {
      searchFrom = restartFrom
      continue
    }
    if (labelEnd === -1) break
    if (value[labelEnd + 1] !== '(') {
      searchFrom = open + 1
      continue
    }

    let depth = 0
    let urlEnd = -1
    restartFrom = -1
    cursor = labelEnd + 2
    while (cursor < value.length) {
      const char = value[cursor]
      if (char === '\n' || char === '\r') {
        restartFrom = cursor + 1
        break
      }
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '(') {
        depth += 1
      } else if (char === ')') {
        if (depth === 0) {
          urlEnd = cursor
          break
        }
        depth -= 1
      }
      cursor += 1
    }
    if (restartFrom !== -1) {
      searchFrom = restartFrom
      continue
    }
    if (urlEnd === -1) break
    links.push({
      start: open,
      end: urlEnd + 1,
      label: value.slice(open + 1, labelEnd),
      url: value.slice(labelEnd + 2, urlEnd),
    })
    searchFrom = urlEnd + 1
  }
  return links
}

function recognizedToParsed(
  recognized: RecognizedLink,
  start: number,
  end: number,
  label?: string
): ParsedComposerLink {
  return {
    url: recognized.url,
    label: label || recognized.label,
    iconUrl: recognized.iconUrl,
    provider: recognized.provider,
    start,
    end,
  }
}

export function parseComposerLinks(value: string): ParsedComposerLink[] {
  const links: ParsedComposerLink[] = []
  for (const token of scanMarkdownComposerLinks(value)) {
    const label = unescapeComposerLinkText(token.label)
    const url = trimUrlBoundaries(unescapeComposerLinkText(token.url))
    const recognized = getRecognizedLink(url)
    if (!recognized) continue
    links.push(recognizedToParsed(recognized, token.start, token.end, label || undefined))
  }
  for (const match of value.matchAll(BARE_HTTP_URL_REGEX)) {
    const start = match.index ?? 0
    if (value.slice(start - 2, start) === '](') continue
    const url = trimUrlBoundaries(match[0])
    const recognized = getRecognizedLink(url)
    if (!recognized) continue
    if (links.some(link => start >= link.start && start < link.end)) continue
    links.push(recognizedToParsed(recognized, start, start + url.length))
  }
  return links.sort((a, b) => a.start - b.start)
}

export function applyLinkIcon(icon: HTMLImageElement, payload: ComposerLinkPayload): void {
  const url = payload.url
  icon.dataset.appliedLinkUrl = url
  const iconUrl =
    payload.iconUrl && payload.iconUrl !== GENERIC_LINK_ICON_SRC
      ? payload.iconUrl
      : (getRecognizedLink(payload.url)?.iconUrl ?? '')
  icon.src = iconUrl || GENERIC_LINK_ICON_SRC
  icon.onerror = () => {
    if (icon.src !== GENERIC_LINK_ICON_SRC) icon.src = GENERIC_LINK_ICON_SRC
  }
  if (payload.provider === 'web') {
    resolveAndProbeIcon(
      url,
      resolveFavicon(url),
      favicon => {
        if (icon.isConnected && icon.dataset.appliedLinkUrl === url) icon.src = favicon
      },
      () => !icon.isConnected || icon.dataset.appliedLinkUrl !== url
    )
  }
}

export function createComposerLinkElement(payload: ComposerLinkPayload): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = 'composer-link-node composer-mention-link'
  element.setAttribute('data-testid', 'composer-link-chip')
  element.setAttribute('data-composer-link-url', payload.url)
  element.setAttribute('data-composer-link-provider', payload.provider)
  element.setAttribute('data-composer-link-label', payload.label)
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('aria-label', payload.label)
  element.setAttribute('spellcheck', 'false')
  element.setAttribute('tabindex', '0')

  const iconSlot = document.createElement('span')
  iconSlot.className = 'composer-mention-icon-slot'
  iconSlot.setAttribute('aria-hidden', 'true')
  const icon = document.createElement('img')
  icon.className = 'composer-mention-icon'
  icon.alt = ''
  icon.loading = 'lazy'
  applyLinkIcon(icon, payload)
  iconSlot.append(icon)

  const label = document.createElement('span')
  label.className = 'composer-mention-label'
  label.textContent = payload.label

  element.append(iconSlot, label)
  return element
}
