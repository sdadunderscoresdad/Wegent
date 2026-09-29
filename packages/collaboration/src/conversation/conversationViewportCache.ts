const MAX_CONVERSATION_CACHE_ENTRIES = 50
const snapshots = new Map<string, ConversationScrollSnapshot>()

export interface ConversationScrollSnapshot {
  schemaVersion: 1
  mode: 'following' | 'reading'
  messageId?: string
  messageIndex?: number
  offsetWithinAnchorPx?: number
  viewportWidthPx?: number
}

export function getConversationScrollSnapshot(key: string) {
  const snapshot = snapshots.get(key)
  if (snapshot) {
    snapshots.delete(key)
    snapshots.set(key, snapshot)
  }
  return snapshot
}

export function hasConversationScrollSnapshot(key: string) {
  return snapshots.has(key)
}

export function cacheConversationScrollSnapshot(key: string, snapshot: ConversationScrollSnapshot) {
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  while (snapshots.size > MAX_CONVERSATION_CACHE_ENTRIES) {
    const oldest = snapshots.keys().next().value
    if (oldest !== undefined) evictConversationViewport(oldest)
  }
}

export function evictConversationViewport(key: string) {
  snapshots.delete(key)
  evictPersistentProcessingExpansions(key)
}

export function clearConversationViewportCache() {
  snapshots.clear()
  clearPersistentProcessingExpansions()
}

export function getConversationViewportCacheStats() {
  return { scrollSnapshotEntries: snapshots.size }
}
import {
  clearPersistentProcessingExpansions,
  evictPersistentProcessingExpansions,
} from './blocks/processingExpansionState'
