import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { ControlledResizeObserver } from './conversationViewport.test-utils'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import {
  clearConversationViewportCache,
  getConversationScrollSnapshot,
} from '../../../../packages/collaboration/src/conversation/conversationViewportCache'
import { MessageList } from './MessageList'
import { clearPersistentProcessingExpansions } from '../../../../packages/collaboration/src/conversation/blocks/processingExpansionState'
import '@/i18n'

afterEach(() => {
  cleanup()
  clearPersistentProcessingExpansions()
  clearConversationViewportCache()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const thinking: WorkbenchMessage = {
  id: 'answer',
  role: 'assistant',
  content: '',
  status: 'streaming',
  createdAt: '2026-09-28T00:00:00Z',
  blocks: [
    {
      id: 'analysis',
      subtaskId: 1,
      type: 'text',
      content: 'Working through the long investigation.',
      status: 'done',
      createdAt: 1,
    },
    {
      id: 'command',
      subtaskId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      status: 'done',
      createdAt: 2,
    },
  ],
}

test('keeps the process through streaming and collapses only when the turn completes', () => {
  const { rerender, unmount } = render(<MessageList messages={[thinking]} />)
  const narrative = screen.getByText('Working through the long investigation.')
  const preview = screen.getByTestId('processing-live-preview')
  for (const content of ['Final', 'Final answer', 'Final answer continued']) {
    rerender(<MessageList messages={[{ ...thinking, content }]} />)
    expect(narrative.isConnected).toBe(true)
    expect(screen.getByTestId('processing-live-preview')).toBe(preview)
  }
  const answer = screen.getByTestId('assistant-message-content')
  rerender(
    <MessageList messages={[{ ...thinking, content: 'Final answer continued', status: 'done' }]} />
  )
  expect(narrative.isConnected).toBe(false)
  expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()
  expect(screen.getByTestId('assistant-message-content')).toBe(answer)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  unmount()
  render(
    <MessageList messages={[{ ...thinking, content: 'Final answer continued', status: 'done' }]} />
  )
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

test.each([false, true])(
  'preserves an explicit expanded=%s choice through completion and reopening',
  expanded => {
    const message = { ...thinking, content: 'Final answer begins' }
    const { rerender, unmount } = render(
      <MessageList conversationKey="choice" messages={[message]} />
    )
    const toggle = screen.getByTestId('final-processing-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    if (expanded) fireEvent.click(toggle)
    const completed = { ...message, status: 'done' as const }
    rerender(<MessageList conversationKey="choice" messages={[completed]} />)
    expect(toggle).toHaveAttribute('aria-expanded', String(expanded))
    unmount()
    render(<MessageList conversationKey="choice" messages={[completed]} />)
    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute(
      'aria-expanded',
      String(expanded)
    )
  }
)

test('waits for the active turn to settle even if its current text is already done', () => {
  const message = { ...thinking, content: 'Final answer', status: 'done' as const }
  const { rerender } = render(<MessageList messages={[message]} isWaitingForAssistant />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  rerender(<MessageList messages={[message]} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

test('keeps final output mounted when a delayed tool adds chronological content', () => {
  const first: WorkbenchMessage = {
    ...thinking,
    blocks: [],
    content: 'First answer',
    runtimeDisplayItems: [{ id: 'text-a', type: 'assistant_text', content: 'First answer' }],
  }
  const { rerender } = render(<MessageList messages={[first]} />)
  const answer = screen.getByTestId('assistant-message-content')
  rerender(
    <MessageList
      messages={[
        {
          ...first,
          blocks: thinking.blocks,
          runtimeDisplayItems: [...first.runtimeDisplayItems!, { id: 'command', type: 'block' }],
        },
      ]}
    />
  )
  expect(screen.getByTestId('assistant-message-content')).toBe(answer)
})

test('preserves the timeline and code nodes across whitespace at streaming chunk boundaries', () => {
  const initial = '```sql\nSELECT 1;'
  const message = (content: string): WorkbenchMessage => ({
    ...thinking,
    content,
    runtimeDisplayItems: [
      { id: 'analysis', type: 'block' },
      { id: 'command', type: 'block' },
      { id: 'text-a', type: 'assistant_text', content },
    ],
  })
  const { rerender } = render(<MessageList messages={[message('')]} />)
  rerender(<MessageList messages={[message(initial)]} />)
  const answer = screen.getByTestId('assistant-message-content')
  const code = answer.querySelector('code')
  const narrative = screen.getByText('Working through the long investigation.')
  expect(code).not.toBeNull()

  for (const content of [initial + '\n', initial + '\nSELECT ', initial + '\nSELECT 2;\n```']) {
    rerender(<MessageList messages={[message(content)]} />)
    expect(screen.getByTestId('assistant-message-content')).toBe(answer)
    expect(answer.querySelector('code')).toBe(code)
    expect(screen.getByText('Working through the long investigation.')).toBe(narrative)
  }
})

test('keeps the history reader paused across first final token, growth, and completion', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  ControlledResizeObserver.instances = []
  let height = 1800
  let top = 0
  const history: WorkbenchMessage = {
    id: 'history',
    role: 'assistant',
    status: 'done',
    content: 'Earlier answer being read',
    createdAt: thinking.createdAt,
  }
  const { rerender, unmount } = render(
    <ScrollableMessageArea messages={[history, thinking]} conversationKey="final-reading" />
  )
  const viewport = screen.getByTestId('chat-message-scroll-area')
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 400))
      },
    },
  })
  await act(() => vi.advanceTimersByTimeAsync(100))
  fireEvent.scroll(viewport)
  fireEvent.wheel(viewport, { deltaY: -100 })
  viewport.scrollTop = 950
  fireEvent.scroll(viewport)
  const narrative = screen.getByText('Working through the long investigation.')
  const earlier = screen.getByText('Earlier answer being read')
  for (const [content, status] of [
    ['Final', 'streaming'],
    ['Final answer grows', 'streaming'],
    ['Final answer complete', 'done'],
  ] as const) {
    rerender(
      <ScrollableMessageArea
        messages={[history, { ...thinking, content, status }]}
        conversationKey="final-reading"
      />
    )
    // Model a browser clamp after layout. JSDOM itself does not calculate box geometry.
    // The earlier history leaves enough scroll range after the live process collapses.
    height = 1500 + (narrative.isConnected ? 700 : 0) + content.length * 3
    viewport.scrollTop = top
    act(() => ControlledResizeObserver.notify(viewport.firstElementChild!, height))
    fireEvent.scroll(viewport)
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(viewport.scrollTop).toBe(950)
    expect(screen.getByText('Earlier answer being read')).toBe(earlier)
  }
  unmount()
  expect(getConversationScrollSnapshot('final-reading')?.mode).toBe('reading')
})
