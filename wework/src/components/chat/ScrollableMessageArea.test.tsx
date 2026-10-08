import { StrictMode, createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import type { ConversationViewportActions } from '@wegent/collaboration/conversation'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import {
  cacheConversationScrollSnapshot,
  clearRuntimeConversationCacheForTests,
  getConversationScrollSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import { ControlledResizeObserver } from './conversationViewport.test-utils'

const messages: WorkbenchMessage[] = Array.from({ length: 10 }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `Message ${index}`,
  status: 'done',
  turnId: `turn-${Math.floor(index / 2)}`,
  runtimeMessageIndex: index,
  createdAt: '2026-09-23T00:00:00Z',
}))
let contentHeight = 1000
let viewportHeight = 300
let positions = new WeakMap<Element, number>()
const writes: Array<{ element: Element; top: number }> = []
const scroller = () => screen.getByTestId('chat-message-scroll-area')

function scrollTo(element: HTMLElement, top: number) {
  positions.set(element, top)
  fireEvent.scroll(element)
}
function readAt(top: number, element = scroller()) {
  fireEvent.wheel(element, { deltaY: -20 })
  scrollTo(element, top)
}
async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(100))
}
async function resize(height: number, element = scroller()) {
  contentHeight = height
  act(() => ControlledResizeObserver.notify(element.firstElementChild!, height))
  await settle()
}
function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  contentHeight = 1000
  viewportHeight = 300
  positions = new WeakMap()
  writes.length = 0
  ControlledResizeObserver.instances = []
  clearRuntimeConversationCacheForTests()
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(() => viewportHeight)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function () {
    return positions.get(this) ?? 0
  })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (top) {
    const value = Math.max(0, Math.min(top, contentHeight - viewportHeight))
    positions.set(this, value)
    writes.push({ element: this, top: value })
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const element = this as HTMLElement
    if (!element.dataset.messageId) return rect(0, viewportHeight)
    const viewport = element.closest<HTMLElement>('[data-scroll-origin]')
    const anchors = viewport?.querySelectorAll('[data-message-id]')
    const index = anchors ? Array.from(anchors).indexOf(element) : 0
    return rect(index * 100 - (viewport?.scrollTop ?? 0), 100)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('normal-DOM conversation viewport', () => {
  test.each([false, true])(
    'combines custom message gaps with transcript gap=%s without resuming follow',
    async missing => {
      const history = [messages[0], messages[missing ? 3 : 1]]
      const customGap = (message: WorkbenchMessage) =>
        message.id === history[0].id ? (
          <span data-testid="custom-message-gap">Execution boundary</span>
        ) : null
      const { rerender } = render(
        <ScrollableMessageArea messages={history} renderGapAfterMessage={customGap} />
      )
      await settle()
      expect(screen.getByTestId('custom-message-gap')).toHaveTextContent('Execution boundary')
      expect(screen.queryAllByTestId('runtime-transcript-gap-marker')).toHaveLength(missing ? 1 : 0)
      if (missing) {
        expect(screen.getByTestId('load-runtime-transcript-gap-button')).toBeDisabled()
        expect(
          screen
            .getByTestId('runtime-transcript-gap-marker')
            .compareDocumentPosition(screen.getByTestId('custom-message-gap')) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
      }
      readAt(200)
      rerender(
        <ScrollableMessageArea
          messages={history}
          renderGapAfterMessage={message =>
            message.id === history[0].id ? (
              <span data-testid="custom-message-gap">Updated boundary</span>
            ) : null
          }
        />
      )
      await resize(1400)
      expect(screen.getByTestId('custom-message-gap')).toHaveTextContent('Updated boundary')
      expect(scroller().scrollTop).toBe(200)
      rerender(<ScrollableMessageArea messages={history} />)
      expect(screen.queryByTestId('custom-message-gap')).not.toBeInTheDocument()
      expect(screen.queryAllByTestId('runtime-transcript-gap-marker')).toHaveLength(missing ? 1 : 0)
    }
  )

  test('initializes at the bottom only after loaded messages commit', async () => {
    const { rerender } = render(<ScrollableMessageArea messages={[]} loading conversationKey="A" />)
    await settle()
    expect(screen.getByTestId('chat-loading-state')).toBeInTheDocument()
    expect(writes).toHaveLength(0)
    rerender(<ScrollableMessageArea messages={messages} conversationKey="A" />)
    await settle()
    expect(scroller().scrollTop).toBe(700)
    expect(scroller()).toHaveAttribute('data-scroll-origin', 'top')
    expect(scroller().className).not.toContain('flex-col-reverse')
  })

  test('renders the empty state and keeps both footer slots in normal flow', () => {
    const { rerender } = render(<ScrollableMessageArea messages={[]} />)
    expect(screen.getByTestId('chat-empty-state')).toBeInTheDocument()
    rerender(
      <ScrollableMessageArea
        messages={messages}
        contentFooter={<span>Result</span>}
        stickyFooter={<textarea aria-label="Composer" />}
      />
    )
    const flow = scroller().firstElementChild!
    expect(flow).toContainElement(screen.getByTestId('chat-message-scroll-area-content-footer'))
    expect(flow).toContainElement(screen.getByTestId('chat-message-scroll-area-sticky-footer'))
  })

  test('keeps every loaded message and its DOM identity while scrolling and streaming', async () => {
    const history = Array.from({ length: 100 }, (_, index) => ({
      ...messages[1],
      id: `row-${index}`,
    }))
    const { rerender } = render(<ScrollableMessageArea messages={history} />)
    await settle()
    const first = document.querySelector('[data-message-id="row-0"]')
    const last = document.querySelector('[data-message-id="row-99"]')
    readAt(100)
    rerender(
      <ScrollableMessageArea
        messages={history.map((item, index) =>
          index === 99 ? { ...item, content: 'Streaming continuation', status: 'streaming' } : item
        )}
      />
    )
    await resize(1400)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(100)
    expect(document.querySelector('[data-message-id="row-0"]')).toBe(first)
    expect(document.querySelector('[data-message-id="row-99"]')).toBe(last)
    expect(scroller().scrollTop).toBe(100)
  })

  test('follows content growth using the dependency observer', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    await resize(1400)
    expect(scroller().scrollTop).toBe(1100)
  })

  test('upward input cancels a pending follow before the next frame', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    expect(scroller().scrollTop).toBe(700)
    contentHeight = 1200
    act(() => ControlledResizeObserver.notify(scroller().firstElementChild!, contentHeight))
    fireEvent.wheel(scroller(), { deltaY: -20 })
    await settle()
    expect(scroller().scrollTop).toBe(700)
    await resize(1400)
    expect(scroller().scrollTop).toBe(700)
  })

  test('does not treat background run-start, completion or history refresh as a send', async () => {
    const { rerender } = render(<ScrollableMessageArea messages={messages} conversationKey="A" />)
    await settle()
    readAt(200)
    rerender(
      <ScrollableMessageArea messages={[...messages]} isWaitingForAssistant conversationKey="A" />
    )
    await resize(1300)
    rerender(
      <ScrollableMessageArea
        messages={[...messages, { ...messages[1], id: 'new', status: 'streaming' }]}
        conversationKey="A"
      />
    )
    await resize(1500)
    expect(scroller().scrollTop).toBe(200)
    expect(screen.getByTestId('scroll-to-bottom-button')).toBeInTheDocument()
  })

  test('explicit local send resumes follow without guessing from the message array', async () => {
    const actions = createRef<ConversationViewportActions>()
    render(<ScrollableMessageArea messages={messages} viewportActionsRef={actions} />)
    await settle()
    readAt(200)
    act(() => actions.current!.follow())
    await settle()
    expect(scroller().scrollTop).toBe(700)
    await resize(1500)
    expect(scroller().scrollTop).toBe(1200)
  })

  test('the return-to-bottom button is cancellable and cannot restart after cancellation', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    readAt(200)
    fireEvent.click(screen.getByTestId('scroll-to-bottom-button'))
    fireEvent.wheel(scroller(), { deltaY: -20 })
    await settle()
    expect(scroller().scrollTop).toBe(200)
    await resize(1500)
    expect(scroller().scrollTop).toBe(200)
  })

  test('continues following a viewport-only resize but never drags a reader', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    act(() => ControlledResizeObserver.notify(scroller(), viewportHeight))
    viewportHeight = 200
    act(() => ControlledResizeObserver.notify(scroller(), viewportHeight))
    await settle()
    expect(scroller().scrollTop).toBe(800)
    readAt(200)
    viewportHeight = 150
    act(() => ControlledResizeObserver.notify(scroller(), viewportHeight))
    await settle()
    expect(scroller().scrollTop).toBe(200)
  })

  test('does not take over nested tool scrolling or composer keyboard navigation', async () => {
    render(
      <ScrollableMessageArea
        messages={messages}
        stickyFooter={
          <div>
            <textarea aria-label="Composer" />
            <div data-testid="nested" style={{ overflowY: 'auto' }}>
              Tool
            </div>
          </div>
        }
      />
    )
    await settle()
    fireEvent.wheel(screen.getByTestId('nested'), { deltaY: -20 })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' })
    await resize(1500)
    expect(scroller().scrollTop).toBe(1200)
  })

  test.each(['Home', 'PageUp', 'ArrowUp'])('honors the reader keyboard intent %s', async key => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    fireEvent.keyDown(scroller(), { key })
    await resize(1500)
    expect(scroller().scrollTop).toBe(700)
  })

  test('keeps following when a child consumes a keyboard event', async () => {
    render(
      <ScrollableMessageArea
        messages={messages}
        stickyFooter={<button onKeyDown={event => event.preventDefault()}>Menu</button>}
      />
    )
    await settle()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Menu' }), { key: 'ArrowUp' })
    await resize(1500)
    expect(scroller().scrollTop).toBe(1200)
  })

  test.each(['', 'plaintext-only'])('keeps editable %s text navigation local', async mode => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', mode)
    scroller().append(editor)
    fireEvent.keyDown(editor, { key: 'Home' })
    await resize(1500)
    expect(scroller().scrollTop).toBe(1200)
  })

  test.each([
    ['finger jitter', 102, 103],
    ['horizontal drag', 150, 120],
    ['scroll toward the bottom', 100, 50],
  ])('does not pause follow for %s', async (_name, x, y) => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    fireEvent.touchStart(scroller(), {
      touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    })
    fireEvent.touchMove(scroller(), {
      touches: [{ identifier: 1, clientX: x, clientY: y }],
    })
    await resize(1500)
    expect(scroller().scrollTop).toBe(1200)
  })

  test('cancels a pending follow when one finger moves toward older messages', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    expect(scroller().scrollTop).toBe(700)
    contentHeight = 1200
    act(() => ControlledResizeObserver.notify(scroller().firstElementChild!, contentHeight))
    fireEvent.touchStart(scroller(), {
      touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    })
    fireEvent.touchMove(scroller(), {
      touches: [{ identifier: 1, clientX: 100, clientY: 115 }],
    })
    await resize(1500)
    expect(scroller().scrollTop).toBe(700)
  })

  test('ignores pinch gestures and ended or cancelled touch sequences', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    const first = { identifier: 1, clientX: 100, clientY: 100 }
    const second = { identifier: 2, clientX: 200, clientY: 100 }
    fireEvent.touchStart(scroller(), { touches: [first, second] })
    fireEvent.touchMove(scroller(), { touches: [{ ...first, clientY: 130 }, second] })
    fireEvent.touchEnd(scroller(), { touches: [] })
    fireEvent.touchMove(scroller(), { touches: [{ ...first, clientY: 140 }] })
    fireEvent.touchStart(scroller(), { touches: [first] })
    fireEvent.touchCancel(scroller(), { touches: [] })
    fireEvent.touchMove(scroller(), { touches: [{ ...first, clientY: 150 }] })
    await resize(1500)
    expect(scroller().scrollTop).toBe(1200)
  })

  test('recognizes reading after a touch reverses direction', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    const finger = { identifier: 1, clientX: 100, clientY: 100 }
    fireEvent.touchStart(scroller(), { touches: [finger] })
    fireEvent.touchMove(scroller(), { touches: [{ ...finger, clientY: 50 }] })
    fireEvent.touchMove(scroller(), { touches: [{ ...finger, clientY: 65 }] })
    await resize(1500)
    expect(scroller().scrollTop).toBe(700)
  })

  test('keeps nested tool touch input and form shortcuts local', async () => {
    render(
      <ScrollableMessageArea
        messages={messages}
        stickyFooter={
          <div>
            <div data-testid="nested-touch" style={{ overflowY: 'auto' }}>
              Output
            </div>
            <select aria-label="Output format">
              <option>Text</option>
            </select>
            <button>Action</button>
          </div>
        }
      />
    )
    await settle()
    const nested = screen.getByTestId('nested-touch')
    fireEvent.touchStart(nested, {
      touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    })
    fireEvent.touchMove(nested, {
      touches: [{ identifier: 1, clientX: 100, clientY: 150 }],
    })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Home' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Action' }), { key: ' ', shiftKey: true })
    fireEvent.keyDown(scroller(), { key: 'ArrowUp', isComposing: true })
    await resize(1500)
    expect(scroller().scrollTop).toBe(1200)
  })

  test('keeps reading through disclosure and restores its state after A → B → A', async () => {
    const longMessages = [
      { ...messages[0], content: 'Long message. '.repeat(150) },
      ...messages.slice(1),
    ]
    const { rerender } = render(
      <ScrollableMessageArea messages={longMessages} conversationKey="A" />
    )
    await settle()
    const toggle = screen.getByTestId('toggle-user-message-button')
    fireEvent.click(toggle)
    await resize(1500)
    expect(scroller().scrollTop).toBe(700)
    expect(screen.getByTestId('toggle-user-message-button')).toBe(toggle)
    readAt(200)
    rerender(<ScrollableMessageArea messages={messages} conversationKey="B" />)
    await settle()
    rerender(<ScrollableMessageArea messages={longMessages} conversationKey="A" />)
    await settle()
    expect(screen.getByTestId('toggle-user-message-button')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(scroller().scrollTop).toBe(200)
  })

  test.each(['{Enter}', ' '])('pauses before keyboard disclosure %s', async key => {
    vi.useRealTimers()
    const user = userEvent.setup()
    render(
      <ScrollableMessageArea
        messages={[{ ...messages[0], content: 'Long message. '.repeat(150) }]}
      />
    )
    await waitFor(() => expect(scroller().scrollTop).toBe(700))
    screen.getByTestId('toggle-user-message-button').focus()
    await user.keyboard(key)
    expect(screen.getByTestId('toggle-user-message-button')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    contentHeight = 1500
    writes.length = 0
    await act(async () => {
      ControlledResizeObserver.notify(scroller().firstElementChild!, contentHeight)
      await new Promise(requestAnimationFrame)
    })
    expect(scroller().scrollTop).toBe(700)
    expect(writes).toHaveLength(0)
  })

  test('restores a stable message offset instead of a distance from a growing bottom', async () => {
    const first = render(<ScrollableMessageArea messages={messages} conversationKey="A" />)
    await settle()
    readAt(230)
    first.unmount()
    expect(getConversationScrollSnapshot('A')).toMatchObject({
      mode: 'reading',
      messageId: 'message-2',
      offsetWithinAnchorPx: 30,
    })
    contentHeight = 1500
    render(<ScrollableMessageArea messages={messages} conversationKey="A" />)
    await settle()
    expect(scroller().scrollTop).toBe(230)
    await resize(2000)
    expect(scroller().scrollTop).toBe(230)
  })

  test('does not overwrite a snapshot while an empty reopened pane loads', async () => {
    const saved = {
      schemaVersion: 1 as const,
      mode: 'reading' as const,
      messageId: 'message-2',
      offsetWithinAnchorPx: 30,
    }
    cacheConversationScrollSnapshot('A', saved)
    const first = render(<ScrollableMessageArea messages={[]} loading conversationKey="A" />)
    await settle()
    first.unmount()
    expect(getConversationScrollSnapshot('A')).toEqual(saved)
  })

  test('degrades a deleted snapshot anchor to a nearest loaded message, not the bottom', async () => {
    cacheConversationScrollSnapshot('A', {
      schemaVersion: 1,
      mode: 'reading',
      messageId: 'deleted',
      messageIndex: 3,
      offsetWithinAnchorPx: 50,
    })
    render(<ScrollableMessageArea messages={messages} conversationKey="A" />)
    await settle()
    expect(scroller().scrollTop).toBe(300)
  })

  test('a preview can explicitly choose latest instead of a saved reading position', async () => {
    cacheConversationScrollSnapshot('A', {
      schemaVersion: 1,
      mode: 'reading',
      messageId: 'message-2',
    })
    render(
      <ScrollableMessageArea
        messages={messages}
        conversationKey="A"
        initialScrollPosition="latest"
      />
    )
    await settle()
    expect(scroller().scrollTop).toBe(700)
  })

  test.each([true, false])('preserves following=%s while the pane is hidden', async following => {
    const { rerender } = render(<ScrollableMessageArea messages={messages} />)
    await settle()
    if (!following) readAt(230)
    rerender(<ScrollableMessageArea messages={messages} autoScrollSuspended />)
    await resize(1500)
    expect(scroller().scrollTop).toBe(following ? 700 : 230)
    rerender(<ScrollableMessageArea messages={messages} />)
    await settle()
    expect(scroller().scrollTop).toBe(following ? 1200 : 230)
  })

  test('a late restoration load cannot overwrite a different conversation', async () => {
    cacheConversationScrollSnapshot('A', { schemaVersion: 1, mode: 'reading', messageId: 'older' })
    let resolve!: () => void
    const load = vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
    const navigation = [
      {
        id: 'older',
        turnIndex: 0,
        messageIndex: -1,
        promptPreview: 'Older',
        responsePreview: '',
        cursor: 'older',
        loaded: false,
      },
    ]
    const { rerender } = render(
      <ScrollableMessageArea
        messages={messages}
        conversationKey="A"
        turnNavigation={navigation}
        onLoadTurnNavigationItem={load}
      />
    )
    await settle()
    expect(load).toHaveBeenCalledOnce()
    rerender(<ScrollableMessageArea messages={messages} conversationKey="B" />)
    await settle()
    readAt(230)
    writes.length = 0
    await act(async () => resolve())
    await settle()
    expect(scroller().scrollTop).toBe(230)
    expect(writes).toHaveLength(0)
  })

  test('preserves the original snapshot when a restore loader throws synchronously', async () => {
    const snapshot = { schemaVersion: 1 as const, mode: 'reading' as const, messageId: 'older' }
    cacheConversationScrollSnapshot('A', snapshot)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.fn(() => {
      throw new Error('History unavailable')
    })
    const mounted = render(
      <ScrollableMessageArea
        messages={messages}
        conversationKey="A"
        turnNavigation={[
          {
            id: 'older',
            turnIndex: 0,
            messageIndex: -1,
            promptPreview: 'Older',
            responsePreview: '',
            cursor: 'older',
            loaded: false,
          },
        ]}
        onLoadTurnNavigationItem={load}
      />
    )
    expect(screen.getByTestId('chat-message-scroll-area-content')).not.toBeVisible()
    await settle()
    expect(load).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('reading position load failed'),
      expect.objectContaining({ messageId: 'older' })
    )
    expect(writes).toHaveLength(0)
    expect(screen.getByTestId('chat-message-scroll-area-content')).toBeVisible()
    mounted.unmount()
    expect(getConversationScrollSnapshot('A')).toEqual(snapshot)
  })

  test('history insertion preserves original message instances and does not issue a follow', async () => {
    const { rerender } = render(<ScrollableMessageArea messages={messages} />)
    await settle()
    readAt(230)
    const anchor = document.querySelector('[data-message-id="message-2"]')
    writes.length = 0
    rerender(<ScrollableMessageArea messages={[{ ...messages[0], id: 'older' }, ...messages]} />)
    await resize(1100)
    expect(document.querySelector('[data-message-id="message-2"]')).toBe(anchor)
    expect(writes).toHaveLength(0)
  })

  test('navigates once to a loaded turn and stays in reading mode', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
    await settle()
    expect(scroller().scrollTop).toBe(0)
    writes.length = 0
    await resize(1500)
    expect(writes).toHaveLength(0)
  })

  test('invalidates a delayed missing-turn navigation when the user takes over', async () => {
    let resolve!: () => void
    const load = vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
    const navigation = [
      {
        id: 'older-user',
        turnId: 'older-turn',
        turnIndex: 0,
        messageIndex: -2,
        promptPreview: 'Older',
        responsePreview: '',
        cursor: 'older',
        loaded: false,
      },
      {
        id: 'message-0',
        turnId: 'turn-0',
        turnIndex: 1,
        messageIndex: 0,
        promptPreview: 'Current',
        responsePreview: '',
        cursor: null,
        loaded: true,
      },
    ]
    const { rerender } = render(
      <ScrollableMessageArea
        messages={messages.slice(0, 2)}
        turnNavigation={navigation}
        onLoadTurnNavigationItem={load}
      />
    )
    await settle()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
    expect(load).toHaveBeenCalledOnce()
    readAt(200)
    await act(async () => resolve())
    rerender(
      <ScrollableMessageArea
        messages={[{ ...messages[0], id: 'older-user' }, ...messages.slice(0, 2)]}
        turnNavigation={navigation}
        onLoadTurnNavigationItem={load}
      />
    )
    await settle()
    expect(scroller().scrollTop).toBe(200)
    expect(screen.queryByTestId('message-turn-navigation-loading')).not.toBeInTheDocument()
  })

  test('completes missing-turn navigation when the loaded target commits', async () => {
    let resolve!: () => void
    const load = vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
    const navigation = [
      {
        id: 'older-user',
        turnIndex: 0,
        messageIndex: -2,
        promptPreview: 'Older',
        responsePreview: '',
        cursor: 'older',
        loaded: false,
      },
      {
        id: 'message-0',
        turnIndex: 1,
        messageIndex: 0,
        promptPreview: 'Current',
        responsePreview: '',
        cursor: null,
        loaded: true,
      },
    ]
    const { rerender } = render(
      <ScrollableMessageArea
        messages={messages.slice(0, 2)}
        turnNavigation={navigation}
        onLoadTurnNavigationItem={load}
      />
    )
    await settle()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
    await act(async () => resolve())
    rerender(
      <ScrollableMessageArea
        messages={[
          { ...messages[0], id: 'older-user', runtimeMessageIndex: -2 },
          ...messages.slice(0, 2),
        ]}
        turnNavigation={navigation}
        onLoadTurnNavigationItem={load}
      />
    )
    await settle()
    expect(scroller().scrollTop).toBe(0)
    expect(screen.queryByTestId('message-turn-navigation-loading')).not.toBeInTheDocument()
    await resize(1500)
    expect(scroller().scrollTop).toBe(0)
  })

  test.each(['wheel', 'keyboard'])('isolates simultaneous viewport %s input', async input => {
    render(
      <>
        <ScrollableMessageArea messages={messages} conversationKey="A" />
        <ScrollableMessageArea messages={messages} conversationKey="B" scrollTestId="second" />
      </>
    )
    await settle()
    if (input === 'wheel') readAt(200)
    else {
      fireEvent.keyDown(scroller(), { key: 'PageUp' })
      scrollTo(scroller(), 200)
    }
    await resize(1500)
    await resize(1500, screen.getByTestId('second'))
    expect(scroller().scrollTop).toBe(200)
    expect(screen.getByTestId('second').scrollTop).toBe(1200)
  })

  test('binds only the external viewport and accepts its scrollbar intent', async () => {
    const external = createRef<HTMLDivElement>()
    const interaction = createRef<HTMLDivElement>()
    render(
      <>
        <div ref={external} data-testid="external" style={{ overflowY: 'auto' }}>
          <ScrollableMessageArea
            messages={messages}
            externalScrollRef={external}
            externalScrollInteractionRef={interaction}
          />
        </div>
        <div ref={interaction} data-testid="track" />
      </>
    )
    await settle()
    expect(external.current!.scrollTop).toBe(700)
    expect(scroller().scrollTop).toBe(0)
    expect(scroller().className).not.toContain('overflow-y-auto')
    fireEvent.keyDown(screen.getByTestId('track'), { key: 'Tab' })
    await resize(1200)
    expect(external.current!.scrollTop).toBe(900)
    fireEvent.pointerDown(screen.getByTestId('track'))
    await resize(1500)
    expect(external.current!.scrollTop).toBe(900)
  })

  test('releases observers, callbacks and pending work in StrictMode', async () => {
    const mounted = render(
      <StrictMode>
        <ScrollableMessageArea messages={messages} />
      </StrictMode>
    )
    await settle()
    mounted.unmount()
    await settle()
    expect(ControlledResizeObserver.instances.every(observer => observer.targets.size === 0)).toBe(
      true
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})
