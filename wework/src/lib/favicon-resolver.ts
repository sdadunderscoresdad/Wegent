import { getToken } from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { normalizeHostname } from './link-preview'

export const GENERIC_LINK_ICON_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/%3E%3Cpath d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/%3E%3C/svg%3E"

const SUCCESS_TTL_MS = 60 * 60 * 1000
const NO_FAVICON_TTL_MS = 60 * 60 * 1000
const FAILED_RESOLUTION_TTL_MS = 30 * 60 * 1000

interface FaviconCacheEntry {
  favicon: string | undefined
  expiresAt: number
}

interface UrlMetadataResult {
  url: string
  title?: string | null
  description?: string | null
  favicon?: string | null
  success: boolean
}

const faviconCache = new Map<string, FaviconCacheEntry>()
const pendingByDomain = new Map<string, Promise<string | undefined>>()

interface ProbeSubscriber {
  onLoad: () => void
  onError: () => void
}

interface ProbeState {
  pending: boolean
  loaded: boolean
  subscribers: ProbeSubscriber[]
}

/**
 * In-flight and resolved image probes, keyed by the icon URL. Pasting many
 * links from the same site would otherwise create one `<img>` probe per chip
 * for the identical `/favicon.ico`; sharing the probe keeps that to a single
 * load per site.
 */
const probeByIconUrl = new Map<string, ProbeState>()

/**
 * Drops in-flight and resolved probe state so subsequent chips start from a
 * clean slate. Mirrors Codex's per-node-view icon registry teardown: editor
 * and component tests call this between cases to avoid sharing probe state
 * across a jsdom run where images never settle.
 */
export function resetFaviconProbeCache(): void {
  probeByIconUrl.clear()
}

function probeIconOnce(iconUrl: string, onLoad: () => void, onError: () => void): void {
  const existing = probeByIconUrl.get(iconUrl)
  if (existing?.loaded) {
    onLoad()
    return
  }
  if (existing?.pending) {
    existing.subscribers.push({ onLoad, onError })
    return
  }
  const state: ProbeState = { pending: true, loaded: false, subscribers: [{ onLoad, onError }] }
  probeByIconUrl.set(iconUrl, state)
  const image = new Image()
  image.onload = () => {
    state.pending = false
    state.loaded = true
    const subscribers = state.subscribers
    state.subscribers = []
    for (const subscriber of subscribers) subscriber.onLoad()
  }
  image.onerror = () => {
    state.pending = false
    probeByIconUrl.delete(iconUrl)
    const subscribers = state.subscribers
    state.subscribers = []
    for (const subscriber of subscribers) subscriber.onError()
  }
  image.src = iconUrl
}

/**
 * Best-effort favicon lookup for a URL. Returns the site's real favicon when
 * the backend resolves it, otherwise undefined so callers keep the generic
 * link icon. Successful and "no favicon" results are cached for an hour, and
 * a reachable backend's failed resolutions for 30 minutes; network failures
 * are NOT cached, so favicons recover as soon as the backend is reachable
 * again instead of being disabled for the whole session. A cached favicon
 * that fails to render is evicted (see `resolveAndProbeIcon`) rather than
 * sticking for the whole cache TTL.
 */
export function resolveFavicon(url: string): Promise<string | undefined> {
  let domain: string | undefined
  try {
    domain = normalizeHostname(new URL(url).hostname)
  } catch {
    return Promise.resolve(undefined)
  }
  if (!domain) return Promise.resolve(undefined)

  const cached = faviconCache.get(domain)
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.favicon)
  }
  const pending = pendingByDomain.get(domain)
  if (pending) return pending

  const request = createHttpClient({
    baseUrl: getRuntimeConfig().apiBaseUrl,
    getToken,
    redirectOnUnauthorized: false,
  })
    .get<UrlMetadataResult>(`/utils/url-metadata?url=${encodeURIComponent(url)}`)
    .then(result => {
      const favicon = result.favicon || undefined
      const ttl = result.success
        ? favicon
          ? SUCCESS_TTL_MS
          : NO_FAVICON_TTL_MS
        : FAILED_RESOLUTION_TTL_MS
      faviconCache.set(domain, { favicon, expiresAt: Date.now() + ttl })
      return favicon
    })
    .catch(() => undefined)
    .finally(() => {
      pendingByDomain.delete(domain)
    })
  pendingByDomain.set(domain, request)
  return request
}

/**
 * The site's conventional `/favicon.ico` URL, derived from the URL's own
 * scheme, host and port. It loads directly from the site without the backend,
 * so it can show a site-specific icon even when the backend is unreachable.
 */
export function faviconPlaceholderUrl(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const domain = normalizeHostname(parsed.hostname)
  if (!domain) return undefined
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${parsed.protocol}//${domain}${port}/favicon.ico`
}

/**
 * Drops a domain's cached favicon so the next `resolveFavicon` call retries
 * instead of serving a URL that failed to render.
 */
export function evictFaviconCache(url: string): void {
  let domain: string | undefined
  try {
    domain = normalizeHostname(new URL(url).hostname)
  } catch {
    return
  }
  if (!domain) return
  faviconCache.delete(domain)
}

/**
 * Probes the site's `/favicon.ico` placeholder and the backend-resolved
 * favicon, showing each only once it has actually loaded so the generic icon
 * stays as the instant base (no blank flash). The backend favicon, once
 * loaded, wins over the placeholder. If the backend favicon fails to load —
 * e.g. a site that serves HTML at `/favicon.ico` — the cache entry is evicted
 * so the next render re-resolves instead of showing the generic icon for the
 * whole cache TTL. Probes are shared per icon URL, so chips pasted from the
 * same site resolve their placeholder once. `faviconPromise` is passed in so
 * callers can provide a mocked resolution in tests.
 */
export function resolveAndProbeIcon(
  url: string,
  faviconPromise: Promise<string | undefined>,
  show: (iconUrl: string) => void,
  isDisposed: () => boolean
): void {
  const placeholder = faviconPlaceholderUrl(url)
  let backendIconShown = false
  if (placeholder) {
    probeIconOnce(
      placeholder,
      () => {
        if (!isDisposed() && !backendIconShown) show(placeholder)
      },
      () => undefined
    )
  }
  void faviconPromise.then(favicon => {
    if (!favicon || isDisposed()) return
    probeIconOnce(
      favicon,
      () => {
        if (isDisposed()) return
        backendIconShown = true
        show(favicon)
      },
      () => evictFaviconCache(url)
    )
  })
}
