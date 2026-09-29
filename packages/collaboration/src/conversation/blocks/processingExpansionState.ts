import { useCallback, useState, useSyncExternalStore } from 'react'

const MAX_STORED_EXPANSION_STATES = 2000
const expansionStateByKey = new Map<string, boolean>()
const expansionStateListenersByKey = new Map<string, Set<() => void>>()

type ExpansionUpdate = boolean | ((value: boolean) => boolean)

export function usePersistentProcessingExpansion(
  key: string | undefined,
  initialValue = false
): readonly [boolean, (update: ExpansionUpdate) => void] {
  const [localExpanded, setLocalExpanded] = useState(initialValue)
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {}
      const listeners = expansionStateListenersByKey.get(key) ?? new Set<() => void>()
      expansionStateListenersByKey.set(key, listeners)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) expansionStateListenersByKey.delete(key)
      }
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

export function clearPersistentProcessingExpansions() {
  if (expansionStateByKey.size === 0) return
  const changedKeys = Array.from(expansionStateByKey.keys())
  expansionStateByKey.clear()
  changedKeys.forEach(emitExpansionStateChange)
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
  changedKeys.forEach(emitExpansionStateChange)
}

function readExpansionState(key: string | undefined, initialValue: boolean): boolean {
  if (!key) return initialValue
  return expansionStateByKey.get(key) ?? initialValue
}

function rememberExpansionState(key: string, value: boolean) {
  if (expansionStateByKey.get(key) === value) return
  let evictedKey: string | undefined
  if (!expansionStateByKey.has(key) && expansionStateByKey.size >= MAX_STORED_EXPANSION_STATES) {
    evictedKey = expansionStateByKey.keys().next().value
    if (evictedKey !== undefined) expansionStateByKey.delete(evictedKey)
  }
  expansionStateByKey.set(key, value)
  if (evictedKey !== undefined) emitExpansionStateChange(evictedKey)
  emitExpansionStateChange(key)
}

function emitExpansionStateChange(key: string) {
  const listeners = expansionStateListenersByKey.get(key)
  if (!listeners) return
  for (const listener of Array.from(listeners)) {
    listener()
  }
}
