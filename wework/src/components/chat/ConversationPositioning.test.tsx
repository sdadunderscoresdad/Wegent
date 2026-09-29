import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  cacheConversationScrollSnapshot,
  clearRuntimeConversationCacheForTests,
  getConversationScrollSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { ControlledResizeObserver } from './conversationViewport.test-utils'
import { useLayoutEffect, useRef } from 'react'

const messages: WorkbenchMessage[] = Array.from({ length: 10 }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `Message ${index}`,
  status: 'done',
  turnId: `turn-${Math.floor(index / 2)}`,
  runtimeMessageIndex: index,
  createdAt: '2026-09-28T00:00:00Z',
}))
let contentHeight = 1000
let positions = new WeakMap<Element, number>()
const scroller = () => screen.getByTestId('chat-message-scroll-area')

function scroll(top: number) {
  positions.set(scroller(), top)
  fireEvent.scroll(scroller())
}

async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(100))
}

async function resize(height: number) {
  contentHeight = height
  act(() => ControlledResizeObserver.notify(scroller().firstElementChild!, height))
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  contentHeight = 1000
  positions = new WeakMap()
  ControlledResizeObserver.instances = []
  clearRuntimeConversationCacheForTests()
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function () {
    return positions.get(this) ?? 0
  })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (top) {
    positions.set(this, Math.max(0, Math.min(top, contentHeight - 300)))
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const element = this as HTMLElement
    const viewport = element.closest<HTMLElement>('[data-scroll-origin]')
    const index = Number(element.dataset.messageId?.split('-').at(-1) ?? 0)
    const top = element.dataset.messageId ? index * 100 - (viewport?.scrollTop ?? 0) : 0
    return { top, bottom: top + 100, left: 0, right: 600, width: 600, height: 100 } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('conversation programmatic positioning', () => {
  test.each([false, true])(
    'positions the first visible commit before any animation frame (external: %s)',
    external => {
      const painted: number[] = []
      function Host() {
        const viewport = useRef<HTMLDivElement>(null)
        useLayoutEffect(() => {
          const content = screen.getByTestId('chat-message-scroll-area-content')
          if (content.style.visibility !== 'hidden') {
            painted.push((external ? viewport.current! : scroller()).scrollTop)
          }
        })
        return (
          <div ref={viewport}>
            <ScrollableMessageArea
              messages={messages}
              conversationKey="first"
              externalScrollRef={external ? viewport : undefined}
            />
          </div>
        )
      }
      render(<Host />)
      expect(painted.every(top => top === 700)).toBe(true)
      expect(screen.getByTestId('chat-message-scroll-area-content')).toBeVisible()
      expect((external ? scroller().parentElement!.parentElement! : scroller()).scrollTop).toBe(700)
    }
  )

  test('restores a reading anchor before any animation frame when history arrives', () => {
    cacheConversationScrollSnapshot('A', {
      schemaVersion: 1,
      mode: 'reading',
      messageId: 'message-3',
      offsetWithinAnchorPx: 15,
    })
    const { rerender } = render(<ScrollableMessageArea messages={[]} loading conversationKey="A" />)
    rerender(<ScrollableMessageArea messages={messages} conversationKey="A" />)
    expect(scroller().scrollTop).toBe(315)
    expect(screen.getByTestId('chat-message-scroll-area-content')).toBeVisible()
  })

  test('reveals asynchronously loaded history only after restoring its reading anchor', async () => {
    cacheConversationScrollSnapshot('A', {
      schemaVersion: 1,
      mode: 'reading',
      messageId: 'message-2',
      messageIndex: 2,
      offsetWithinAnchorPx: 15,
    })
    let finish!: () => void
    const load = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const props = {
      conversationKey: 'A',
      onLoadTurnNavigationItem: load,
      turnNavigation: [
        {
          id: 'message-2',
          turnIndex: 1,
          messageIndex: 2,
          promptPreview: 'Older',
          responsePreview: '',
          cursor: 'older',
          loaded: false,
        },
      ],
    }
    const { rerender } = render(<ScrollableMessageArea {...props} messages={messages.slice(6)} />)
    expect(screen.getByTestId('chat-message-scroll-area-content')).not.toBeVisible()
    await act(async () => {
      await Promise.resolve()
    })
    expect(load).toHaveBeenCalledOnce()
    await act(async () => {
      rerender(<ScrollableMessageArea {...props} messages={messages} />)
      finish()
    })
    expect(scroller().scrollTop).toBe(215)
    expect(screen.getByTestId('chat-message-scroll-area-content')).toBeVisible()
    await resize(1400)
    expect(scroller().scrollTop).toBe(215)
  })

  test('keeps reading after navigating to a turn clamped at the physical bottom', async () => {
    const rendered = render(<ScrollableMessageArea messages={messages} conversationKey="A" />)
    await settle()
    fireEvent.scroll(scroller())
    fireEvent.wheel(scroller(), { deltaY: -20 })
    scroll(100)
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker').at(-1)!)
    expect(scroller().scrollTop).toBe(700)
    fireEvent.scroll(scroller())
    await resize(1400)
    expect(scroller().scrollTop).toBe(700)
    rendered.unmount()
    expect(getConversationScrollSnapshot('A')?.mode).toBe('reading')
  })

  test.each([false, true])(
    'keeps a restored reading position paused at the bottom (earlier scroll: %s)',
    async earlierScroll => {
      cacheConversationScrollSnapshot('A', {
        schemaVersion: 1,
        mode: 'reading',
        messageId: 'message-8',
        offsetWithinAnchorPx: 0,
      })
      const { rerender } = render(
        <ScrollableMessageArea messages={[]} loading conversationKey="A" />
      )
      await settle()
      if (earlierScroll) fireEvent.scroll(scroller())
      rerender(<ScrollableMessageArea messages={messages} conversationKey="A" />)
      await settle()
      expect(scroller().scrollTop).toBe(700)
      fireEvent.scroll(scroller())
      await resize(1400)
      expect(scroller().scrollTop).toBe(700)
    }
  )

  test('allows user scrolling to resume following after a programmatic position', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    fireEvent.scroll(scroller())
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
    expect(scroller().scrollTop).toBe(0)
    fireEvent.scroll(scroller())
    fireEvent.wheel(scroller(), { deltaY: 20 })
    scroll(700)
    await resize(1400)
    expect(scroller().scrollTop).toBe(1100)
  })

  test('preserves user takeover before the programmatic scroll event arrives', async () => {
    render(<ScrollableMessageArea messages={messages} />)
    await settle()
    fireEvent.scroll(scroller())
    fireEvent.wheel(scroller(), { deltaY: -20 })
    scroll(100)
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker').at(-1)!)
    expect(scroller().scrollTop).toBe(700)
    fireEvent.wheel(scroller(), { deltaY: -20 })
    scroll(650)
    await resize(1400)
    expect(scroller().scrollTop).toBe(650)
  })

  test.each(['wheel', 'keyboard', 'touch'])(
    'cancels missing-turn navigation when the reader scrolls down via %s',
    async input => {
      let finishLoading!: () => void
      const load = vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishLoading = resolve
          })
      )
      const turnNavigation = messages
        .filter(message => message.role === 'user')
        .map((message, turnIndex) => ({
          id: message.id,
          turnId: message.turnId,
          turnIndex,
          messageIndex: message.runtimeMessageIndex!,
          promptPreview: message.content,
          responsePreview: '',
          cursor: message.id === 'message-0' ? 'older' : null,
          loaded: message.id !== 'message-0',
        }))
      const props = { turnNavigation, onLoadTurnNavigationItem: load }
      const { rerender } = render(<ScrollableMessageArea {...props} messages={messages.slice(2)} />)
      await settle()
      fireEvent.scroll(scroller())
      fireEvent.wheel(scroller(), { deltaY: -20 })
      scroll(100)
      fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
      expect(load).toHaveBeenCalledOnce()
      expect(screen.getByTestId('message-turn-navigation-loading')).toBeInTheDocument()

      if (input === 'wheel') fireEvent.wheel(scroller(), { deltaY: 20 })
      else if (input === 'keyboard') fireEvent.keyDown(scroller(), { key: 'PageDown' })
      else {
        fireEvent.touchStart(scroller(), {
          touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
        })
        fireEvent.touchMove(scroller(), {
          touches: [{ identifier: 1, clientX: 100, clientY: 80 }],
        })
      }
      scroll(700)
      await resize(1400)
      expect(scroller().scrollTop).toBe(1100)

      await act(async () => finishLoading())
      rerender(<ScrollableMessageArea {...props} messages={messages} />)
      await settle()

      expect(scroller().scrollTop).toBe(1100)
      expect(screen.queryByTestId('message-turn-navigation-loading')).not.toBeInTheDocument()
    }
  )
})
