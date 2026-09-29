import { beforeEach, describe, expect, test } from 'vitest'
import {
  cacheConversationScrollSnapshot,
  clearConversationViewportCache,
  evictConversationViewport,
  getConversationScrollSnapshot,
  getConversationViewportCacheStats,
} from '@wegent/collaboration/conversation/conversationViewportCache'
import {
  getConversationScrollSnapshot as getDesktopSnapshot,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'

beforeEach(clearRuntimeConversationCacheForTests)

describe('shared conversation viewport cache', () => {
  test('shares the desktop cache and retains recently read positions at the 50 entry limit', () => {
    for (let index = 0; index < 50; index += 1) {
      cacheConversationScrollSnapshot(`task-${index}`, {
        schemaVersion: 1,
        mode: 'reading',
        messageId: `message-${index}`,
      })
    }
    expect(getDesktopSnapshot('task-0')?.messageId).toBe('message-0')
    cacheConversationScrollSnapshot('new-task', {
      schemaVersion: 1,
      mode: 'following',
    })
    expect(getConversationScrollSnapshot('task-0')).toBeDefined()
    expect(getConversationScrollSnapshot('task-1')).toBeUndefined()
    expect(getConversationViewportCacheStats().scrollSnapshotEntries).toBe(50)
  })

  test('evicts only the requested conversation', () => {
    cacheConversationScrollSnapshot('task-1', {
      schemaVersion: 1,
      mode: 'reading',
      messageId: 'message-1',
    })
    cacheConversationScrollSnapshot('task-2', { schemaVersion: 1, mode: 'following' })
    evictConversationViewport('task-1')
    expect(getConversationScrollSnapshot('task-1')).toBeUndefined()
    expect(getConversationScrollSnapshot('task-2')?.mode).toBe('following')
    clearConversationViewportCache()
    expect(getDesktopSnapshot('task-2')).toBeUndefined()
  })
})
