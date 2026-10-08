import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest'
import {
  clearPersistentProcessingExpansions,
  collapsePersistentProcessingExpansions,
  evictPersistentProcessingExpansions,
  getProcessingDetailStateKey,
  useAnyPersistentProcessingExpansion,
  usePersistentProcessingExpansion,
  usePersistentProcessingSelection,
} from '../../../../packages/collaboration/src/conversation/blocks/processingExpansionState'

const { notifications } = vi.hoisted(() => ({ notifications: [] as Mock<() => void>[] }))

// Count notifications even when React skips rendering an unchanged snapshot.
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useSyncExternalStore<T>(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T
    ) {
      const observeSubscription = react.useCallback(
        (onStoreChange: () => void) => {
          const listener = vi.fn(onStoreChange)
          notifications.push(listener)
          return subscribe(listener)
        },
        [subscribe]
      )
      return react.useSyncExternalStore(observeSubscription, getSnapshot, getServerSnapshot)
    },
  }
})

function renderExpansion(key: string | undefined, initialValue = false) {
  const hook = renderHook(
    ({ stateKey }) => usePersistentProcessingExpansion(stateKey, initialValue),
    { initialProps: { stateKey: key } }
  )
  return { ...hook, notified: notifications.at(-1)! }
}

beforeEach(() => {
  clearPersistentProcessingExpansions()
  notifications.length = 0
})

afterEach(() => {
  cleanup()
  clearPersistentProcessingExpansions()
})

test('synchronizes shared disclosures without notifying other keys', () => {
  const first = renderExpansion('conversation:tool')
  const second = renderExpansion('conversation:tool')
  const unrelated = renderExpansion('conversation:other-tool')

  act(() => first.result.current[1](true))

  expect(first.result.current[0]).toBe(true)
  expect(second.result.current[0]).toBe(true)
  expect(first.notified).toHaveBeenCalledOnce()
  expect(second.notified).toHaveBeenCalledOnce()
  expect(unrelated.notified).not.toHaveBeenCalled()
})

test('does not notify when a persisted value is unchanged', () => {
  const hook = renderExpansion('conversation:tool')
  act(() => hook.result.current[1](true))
  hook.notified.mockClear()

  act(() => hook.result.current[1](current => current))

  expect(hook.result.current[0]).toBe(true)
  expect(hook.notified).not.toHaveBeenCalled()
})

test('persists an explicit choice even when it equals the local default', () => {
  const first = renderExpansion('conversation:tool')
  const second = renderExpansion('conversation:tool', true)

  act(() => first.result.current[1](false))

  expect(second.result.current[0]).toBe(false)
  first.unmount()
  second.unmount()
  expect(renderExpansion('conversation:tool', true).result.current[0]).toBe(false)
})

test('switching keys releases the old subscription while retaining stored choices', () => {
  const changing = renderExpansion('conversation:first')
  const first = renderExpansion('conversation:first')
  act(() => first.result.current[1](true))
  changing.rerender({ stateKey: 'conversation:second' })
  changing.notified.mockClear()
  const secondNotification = notifications.at(-1)!

  act(() => first.result.current[1](false))

  expect(changing.result.current[0]).toBe(false)
  expect(changing.notified).not.toHaveBeenCalled()
  expect(secondNotification).not.toHaveBeenCalled()
  act(() => changing.result.current[1](true))
  changing.unmount()
  expect(renderExpansion('conversation:second').result.current[0]).toBe(true)
})

test('unkeyed disclosures remain local and do not notify persistent subscribers', () => {
  const local = renderExpansion(undefined)
  const otherLocal = renderExpansion(undefined)
  const persisted = renderExpansion('conversation:tool')

  act(() => local.result.current[1](current => !current))

  expect(local.result.current[0]).toBe(true)
  expect(otherLocal.result.current[0]).toBe(false)
  expect(persisted.notified).not.toHaveBeenCalled()
})

test('clearing stored choices restores each default and leaves unstored keys alone', () => {
  const collapsed = renderExpansion('conversation:collapsed')
  const expanded = renderExpansion('conversation:expanded', true)
  const unstored = renderExpansion('conversation:unstored')
  act(() => {
    collapsed.result.current[1](true)
    expanded.result.current[1](false)
  })
  vi.clearAllMocks()

  act(() => clearPersistentProcessingExpansions())

  expect(collapsed.result.current[0]).toBe(false)
  expect(expanded.result.current[0]).toBe(true)
  expect(collapsed.notified).toHaveBeenCalledOnce()
  expect(expanded.notified).toHaveBeenCalledOnce()
  expect(unstored.notified).not.toHaveBeenCalled()
  vi.clearAllMocks()
  act(() => clearPersistentProcessingExpansions())
  expect(collapsed.notified).not.toHaveBeenCalled()
})

test('conversation eviction only notifies its stored disclosure keys', () => {
  const removed = renderExpansion('conversation:tool')
  const retained = renderExpansion('conversation-2:tool')
  const unstored = renderExpansion('conversation:unstored')
  act(() => {
    removed.result.current[1](true)
    retained.result.current[1](true)
  })
  vi.clearAllMocks()

  act(() => evictPersistentProcessingExpansions('conversation'))

  expect(removed.result.current[0]).toBe(false)
  expect(retained.result.current[0]).toBe(true)
  expect(removed.notified).toHaveBeenCalledOnce()
  expect(retained.notified).not.toHaveBeenCalled()
  expect(unstored.notified).not.toHaveBeenCalled()
  vi.clearAllMocks()
  act(() => evictPersistentProcessingExpansions('conversation'))
  expect(removed.notified).not.toHaveBeenCalled()
})

test('the 2000-choice limit notifies the oldest mounted disclosure when it is evicted', () => {
  const oldest = renderExpansion('conversation:oldest')
  const retained = renderExpansion('conversation:retained')
  const writer = renderExpansion('filler:0')
  act(() => {
    oldest.result.current[1](true)
    retained.result.current[1](true)
  })
  for (let index = 0; index < 1998; index++) {
    writer.rerender({ stateKey: `filler:${index}` })
    act(() => writer.result.current[1](true))
  }
  act(() => oldest.result.current[1](true))
  expect(oldest.result.current[0]).toBe(true)
  writer.rerender({ stateKey: 'filler:overflow' })
  const writerNotification = notifications.at(-1)!
  vi.clearAllMocks()

  act(() => writer.result.current[1](true))

  expect(oldest.result.current[0]).toBe(false)
  expect(retained.result.current[0]).toBe(true)
  expect(writer.result.current[0]).toBe(true)
  expect(oldest.notified).toHaveBeenCalledOnce()
  expect(retained.notified).not.toHaveBeenCalled()
  expect(writerNotification).toHaveBeenCalledOnce()
})

test('file selections survive remounting and stay isolated by conversation', () => {
  const key = getProcessingDetailStateKey('conversation:message', 'file')
  const first = renderHook(() => usePersistentProcessingSelection(key))
  act(() => first.result.current[1]('src/main.ts'))
  first.unmount()
  const restored = renderHook(() => usePersistentProcessingSelection(key))
  const other = renderHook(() =>
    usePersistentProcessingSelection(getProcessingDetailStateKey('other:message', 'file'))
  )
  expect(restored.result.current[0]).toBe('src/main.ts')
  expect(other.result.current[0]).toBeNull()
  act(() => other.result.current[1]('src/other.ts'))
  act(() => evictPersistentProcessingExpansions('conversation'))
  expect(restored.result.current[0]).toBeNull()
  expect(other.result.current[0]).toBe('src/other.ts')
})

test('detail aggregates notify only their keys and batch summary collapse once', () => {
  const command = renderExpansion('conversation:command')
  const file = renderHook(() => usePersistentProcessingSelection('conversation:file'))
  const fileNotification = notifications.at(-1)!
  const other = renderExpansion('other:command')
  const keys = ['conversation:command', 'conversation:file']
  const aggregate = renderHook(() => useAnyPersistentProcessingExpansion(keys))
  const aggregateNotification = notifications.at(-1)!
  act(() => other.result.current[1](true))
  expect(aggregateNotification).not.toHaveBeenCalled()
  act(() => {
    command.result.current[1](true)
    file.result.current[1]('src/main.ts')
  })
  expect(aggregate.result.current).toBe(true)
  vi.clearAllMocks()
  act(() => file.result.current[1](current => current))
  expect(fileNotification).not.toHaveBeenCalled()
  expect(aggregateNotification).not.toHaveBeenCalled()

  act(() => collapsePersistentProcessingExpansions(keys))

  expect(command.result.current[0]).toBe(false)
  expect(file.result.current[0]).toBeNull()
  expect(aggregate.result.current).toBe(false)
  expect(aggregateNotification).toHaveBeenCalledOnce()
  expect(other.notified).not.toHaveBeenCalled()
  vi.clearAllMocks()
  act(() => collapsePersistentProcessingExpansions(keys))
  expect(aggregateNotification).not.toHaveBeenCalled()
})

test('changing aggregate keys unsubscribes the previous conversation', () => {
  const old = renderExpansion('old:detail')
  const next = renderExpansion('next:detail')
  const aggregate = renderHook(({ keys }) => useAnyPersistentProcessingExpansion(keys), {
    initialProps: { keys: ['old:detail'] },
  })
  const oldNotification = notifications.at(-1)!
  aggregate.rerender({ keys: ['next:detail'] })
  const nextNotification = notifications.at(-1)!
  act(() => old.result.current[1](true))
  expect(oldNotification).not.toHaveBeenCalled()
  expect(nextNotification).not.toHaveBeenCalled()
  expect(aggregate.result.current).toBe(false)
  act(() => next.result.current[1](true))
  expect(aggregate.result.current).toBe(true)
  expect(nextNotification).toHaveBeenCalledOnce()
  aggregate.unmount()
  nextNotification.mockClear()
  act(() => next.result.current[1](false))
  expect(nextNotification).not.toHaveBeenCalled()
})
