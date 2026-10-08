import { useCallback, useState, useSyncExternalStore } from 'react'

const MAX_STORED_EXPANSION_STATES = 2000
const expansionStateByKey = new Map<string, boolean | string>()
const expansionStateListenersByKey = new Map<string, Set<() => void>>()

type ExpansionUpdate = boolean | ((value: boolean) => boolean)
type SelectionUpdate = string | null | ((value: string | null) => string | null)

export function getProcessingDetailStateKey(scopeKey: string, blockId: string): string {
  return `${scopeKey}:detail:${blockId}`
}

function subscribeToKey(key: string, listener: () => void) {
  const listeners = expansionStateListenersByKey.get(key) ?? new Set<() => void>()
  expansionStateListenersByKey.set(key, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) expansionStateListenersByKey.delete(key)
  }
}

export function usePersistentProcessingExpansion(
  key: string | undefined,
  initialValue = false
): readonly [boolean, (update: ExpansionUpdate) => void] {
  const [localExpanded, setLocalExpanded] = useState(initialValue)
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {}
      return subscribeToKey(key, listener)
    },
    [key]
  )
  const getSnapshot = useCallback(() => readExpansionState(key, initialValue), [initialValue, key])
  const persistedExpanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const expanded = key ? persistedExpanded : localExpanded

  const setPersistentExpanded = useCallback(
    (update: ExpansionUpdate) => {
      if (!key) {
        setLocalExpanded(current => (typeof update === 'function' ? update(current) : update))
        return
      }

      const current = readExpansionState(key, initialValue)
      const next = typeof update === 'function' ? update(current) : update
      rememberExpansionState(key, next)
    },
    [initialValue, key]
  )

  return [expanded, setPersistentExpanded]
}

export function usePersistentProcessingSelection(
  key: string | undefined
): readonly [string | null, (update: SelectionUpdate) => void] {
  const [localSelection, setLocalSelection] = useState<string | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeToKey(key, listener) : () => {}),
    [key]
  )
  const getSnapshot = useCallback(() => readSelectionState(key), [key])
  const persistedSelection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setSelection = useCallback(
    (update: SelectionUpdate) => {
      if (!key) {
        setLocalSelection(current => (typeof update === 'function' ? update(current) : update))
        return
      }
      const current = readSelectionState(key)
      const next = typeof update === 'function' ? update(current) : update
      rememberExpansionState(key, next ?? false)
    },
    [key]
  )
  return [key ? persistedSelection : localSelection, setSelection]
}

export function useAnyPersistentProcessingExpansion(keys: readonly string[]): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = Array.from(new Set(keys), key => subscribeToKey(key, listener))
      return () => unsubscribe.forEach(release => release())
    },
    [keys]
  )
  const getSnapshot = useCallback(() => keys.some(hasStoredExpansionState), [keys])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function collapsePersistentProcessingExpansions(keys: readonly string[]) {
  const changedKeys = keys.filter(hasStoredExpansionState)
  changedKeys.forEach(key => expansionStateByKey.set(key, false))
  emitExpansionStateChanges(changedKeys)
}

export function clearPersistentProcessingExpansions() {
  if (expansionStateByKey.size === 0) return
  const changedKeys = Array.from(expansionStateByKey.keys())
  expansionStateByKey.clear()
  emitExpansionStateChanges(changedKeys)
}

export function evictPersistentProcessingExpansions(conversationKey: string) {
  const prefix = `${conversationKey}:`
  const changedKeys: string[] = []
  for (const key of expansionStateByKey.keys()) {
    if (key.startsWith(prefix)) {
      expansionStateByKey.delete(key)
      changedKeys.push(key)
    }
  }
  emitExpansionStateChanges(changedKeys)
}

function readExpansionState(key: string | undefined, initialValue: boolean): boolean {
  if (!key) return initialValue
  const value = expansionStateByKey.get(key)
  return typeof value === 'boolean' ? value : initialValue
}

function readSelectionState(key: string | undefined): string | null {
  const value = key ? expansionStateByKey.get(key) : undefined
  return typeof value === 'string' ? value : null
}

function hasStoredExpansionState(key: string): boolean {
  return Boolean(expansionStateByKey.get(key))
}

function rememberExpansionState(key: string, value: boolean | string) {
  if (expansionStateByKey.get(key) === value) return
  let evictedKey: string | undefined
  if (!expansionStateByKey.has(key) && expansionStateByKey.size >= MAX_STORED_EXPANSION_STATES) {
    evictedKey = expansionStateByKey.keys().next().value
    if (evictedKey !== undefined) expansionStateByKey.delete(evictedKey)
  }
  expansionStateByKey.set(key, value)
  emitExpansionStateChanges(evictedKey === undefined ? [key] : [evictedKey, key])
}

function emitExpansionStateChanges(keys: readonly string[]) {
  const listeners = new Set<() => void>()
  for (const key of keys) {
    expansionStateListenersByKey.get(key)?.forEach(listener => listeners.add(listener))
  }
  listeners.forEach(listener => listener())
}
