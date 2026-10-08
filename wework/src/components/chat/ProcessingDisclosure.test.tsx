import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { ConversationTranslationProvider } from '@wegent/collaboration/conversation'
import { LiveProcessingPreview } from '../../../../packages/collaboration/src/conversation/blocks/ProcessingPreview'
import { buildProcessingDisplayRows } from '../../../../packages/collaboration/src/conversation/blocks/toolBlockActivity'
import { clearPersistentProcessingExpansions } from '../../../../packages/collaboration/src/conversation/blocks/processingExpansionState'
import {
  cacheConversationScrollSnapshot,
  clearConversationViewportCache,
  evictConversationViewport,
} from '../../../../packages/collaboration/src/conversation/conversationViewportCache'

function preview(appendTool = false) {
  const rows = buildProcessingDisplayRows(
    (appendTool ? ['read-1', 'read-2'] : ['read-1']).map(id => ({
      id,
      subtaskId: 1,
      type: 'tool' as const,
      toolName: 'Read',
      toolInput: { file_path: '/workspace/example.ts' },
      status: 'done' as const,
      createdAt: 1,
    }))
  )
  return (
    <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
      <LiveProcessingPreview
        rows={rows}
        showThinking={false}
        thinkingContent=""
        fileEditDurations={new Map()}
        detailStateScopeKey="conversation:message"
      />
    </ConversationTranslationProvider>
  )
}

afterEach(() => {
  act(() => {
    clearPersistentProcessingExpansions()
    clearConversationViewportCache()
  })
})

test('appending a completed tool preserves the existing group trigger and disclosure choice', () => {
  const { rerender } = render(preview())
  const trigger = screen.getByTestId('processing-activity-group-toggle')
  fireEvent.click(trigger)
  rerender(preview(true))
  expect(screen.getByTestId('processing-activity-group-toggle')).toBe(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
})

test('restores expanded activity groups without clipping them in the compact live preview', () => {
  const first = render(preview())
  fireEvent.click(screen.getByTestId('processing-activity-group-toggle'))
  expect(screen.getByTestId('processing-live-preview-scroll')).toHaveStyle({ maxHeight: 'none' })
  first.unmount()
  render(preview())
  expect(screen.getByTestId('processing-activity-group-toggle')).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  expect(screen.getByTestId('processing-live-preview-scroll')).toHaveStyle({ maxHeight: 'none' })
})

test('conversation eviction clears its disclosure choices', () => {
  render(preview())
  fireEvent.click(screen.getByTestId('processing-activity-group-toggle'))
  act(() => evictConversationViewport('conversation'))
  expect(screen.getByTestId('processing-activity-group-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
})

test('bounded snapshot eviction also releases associated disclosure choices', () => {
  render(preview())
  fireEvent.click(screen.getByTestId('processing-activity-group-toggle'))
  act(() => {
    cacheConversationScrollSnapshot('conversation', { schemaVersion: 1, mode: 'following' })
    for (let index = 0; index < 50; index++) {
      cacheConversationScrollSnapshot(`other-${index}`, { schemaVersion: 1, mode: 'following' })
    }
  })
  expect(screen.getByTestId('processing-activity-group-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
})
