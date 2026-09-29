import { StrictMode, useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useConversationFollow } from '../../../../packages/collaboration/src/conversation/useConversationFollow'
import { ControlledResizeObserver } from './conversationViewport.test-utils'

type Follow = ReturnType<typeof useConversationFollow>

function createFixture({ strict = false } = {}) {
  let follow!: Follow
  let viewportHeight = 300
  let contentHeight = 1000
  let scrollTop = 0
  const writes: number[] = []
  function Fixture({ elementKey = 'first' }: { elementKey?: string }) {
    follow = useConversationFollow()
    useLayoutEffect(() => {
      const viewport = follow.scrollRef.current!
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, get: () => viewportHeight },
        scrollHeight: { configurable: true, get: () => contentHeight },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = Math.max(0, Math.min(value, contentHeight - viewportHeight))
            writes.push(scrollTop)
          },
        },
      })
    }, [elementKey])
    return (
      <div key={elementKey} ref={follow.scrollRef} style={{ overflowY: 'auto' }}>
        <div ref={follow.contentRef}>Transcript</div>
      </div>
    )
  }
  const tree = (key?: string) =>
    strict ? (
      <StrictMode>
        <Fixture elementKey={key} />
      </StrictMode>
    ) : (
      <Fixture elementKey={key} />
    )
  const rendered = render(tree())
  const fixture = {
    get follow() {
      return follow
    },
    get viewport() {
      return follow.scrollRef.current!
    },
    get content() {
      return follow.contentRef.current!
    },
    get top() {
      return scrollTop
    },
    get bottom() {
      return contentHeight - viewportHeight
    },
    writes,
    resizeViewport(height: number, scrollBeforeObserver = false, userTop?: number) {
      viewportHeight = height
      scrollTop = userTop ?? Math.min(scrollTop, fixture.bottom)
      if (scrollBeforeObserver) fireEvent.scroll(fixture.viewport)
      act(() => ControlledResizeObserver.notify(fixture.viewport, height))
    },
    resizeContent(height: number) {
      contentHeight = height
      scrollTop = Math.min(scrollTop, fixture.bottom)
      act(() => ControlledResizeObserver.notify(fixture.content, height))
    },
    scroll(top: number) {
      scrollTop = top
      fireEvent.scroll(fixture.viewport)
    },
    async start() {
      await advance()
      act(() => {
        follow.scrollToBottom('instant')
      })
      await advance()
      fireEvent.scroll(fixture.viewport)
      await advance()
    },
    replace() {
      rendered.rerender(tree('second'))
    },
    unmount: rendered.unmount,
  }
  act(() => {
    ControlledResizeObserver.notify(fixture.viewport, viewportHeight)
    ControlledResizeObserver.notify(fixture.content, contentHeight)
  })
  return fixture
}

async function advance(milliseconds = 100) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds))
}

beforeEach(() => {
  vi.useFakeTimers()
  ControlledResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('conversation follow dependency contract', () => {
  test('does not initialize until the conversation explicitly requests following', async () => {
    const fixture = createFixture()
    await advance()
    expect(fixture.top).toBe(0)
    await fixture.start()
    expect(Math.abs(fixture.bottom - fixture.top)).toBeLessThanOrEqual(2)
  })

  test('follows a viewport-only shrink without any content resize', async () => {
    const fixture = createFixture()
    await fixture.start()
    expect(Math.abs(fixture.bottom - fixture.top)).toBeLessThanOrEqual(2)
    fixture.resizeViewport(200)
    await advance()
    expect(Math.abs(fixture.bottom - fixture.top)).toBeLessThanOrEqual(2)
  })

  test('does not interpret browser clamping on viewport growth as reader input', async () => {
    const fixture = createFixture()
    await fixture.start()
    fixture.resizeViewport(500, true)
    await advance()
    expect(fixture.follow.state.isAtBottom).toBe(true)
    fixture.resizeContent(1400)
    await advance()
    expect(Math.abs(fixture.bottom - fixture.top)).toBeLessThanOrEqual(2)
  })

  test('keeps reading intent through content shrink and subsequent growth', async () => {
    const fixture = createFixture()
    await fixture.start()
    act(() => fixture.follow.stopScroll())
    fixture.resizeContent(900)
    await advance()
    expect(fixture.follow.state.isAtBottom).toBe(false)
    const readingTop = fixture.top
    fixture.resizeContent(1400)
    await advance()
    expect(fixture.top).toBe(readingTop)
  })

  test('escapes on upward wheel input on an overflow-y scroller before the next frame', async () => {
    const fixture = createFixture()
    await fixture.start()
    fixture.resizeContent(1400)
    fireEvent.wheel(fixture.viewport, { deltaY: -20 })
    const readingTop = fixture.top
    await advance()
    expect(fixture.follow.state.isAtBottom).toBe(false)
    expect(fixture.top).toBe(readingTop)
  })

  test('does not escape for an independently scrolling nested tool', async () => {
    const fixture = createFixture()
    await fixture.start()
    const nested = document.createElement('div')
    nested.style.overflowY = 'auto'
    fixture.content.append(nested)
    fireEvent.wheel(nested, { deltaY: -20 })
    await advance()
    expect(fixture.follow.state.isAtBottom).toBe(true)
  })

  test('does not resume reading because a viewport resize reaches the bottom', async () => {
    const fixture = createFixture()
    await fixture.start()
    act(() => fixture.follow.stopScroll())
    fixture.scroll(100)
    fixture.resizeViewport(950, true)
    await advance()
    expect(fixture.follow.state.isAtBottom).toBe(false)
    fixture.resizeViewport(300)
    await advance()
    expect(fixture.top).toBe(50)
  })

  test.each([false, true])(
    'does not swallow user input during resize (scroll before observer: %s)',
    async scrollBeforeObserver => {
      const fixture = createFixture()
      await fixture.start()
      fixture.resizeViewport(500, scrollBeforeObserver, 400)
      if (!scrollBeforeObserver) fireEvent.scroll(fixture.viewport)
      await advance()
      expect(fixture.follow.state.isAtBottom).toBe(false)
      expect(fixture.top).toBe(400)
    }
  )

  test('returns to following only after scrolling down to the actual bottom', async () => {
    const fixture = createFixture()
    await fixture.start()
    act(() => fixture.follow.stopScroll())
    fixture.scroll(500)
    fixture.scroll(650)
    expect(fixture.follow.state.isAtBottom).toBe(false)
    fixture.scroll(700)
    expect(fixture.follow.state.isAtBottom).toBe(true)
  })

  test('cancels an old pending command even when a new follow starts immediately', async () => {
    const fixture = createFixture()
    let oldResult!: ReturnType<Follow['scrollToBottom']>
    act(() => {
      oldResult = fixture.follow.scrollToBottom({ wait: 5000, animation: 'instant' })
      fixture.follow.stopScroll()
      fixture.follow.scrollToBottom('instant')
    })
    await advance()
    expect(await oldResult).toBe(false)
    expect(Math.abs(fixture.bottom - fixture.top)).toBeLessThanOrEqual(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('cancels the library spring immediately on upward input', async () => {
    const fixture = createFixture()
    act(() => {
      fixture.follow.scrollToBottom('smooth')
    })
    await advance(32)
    const readingTop = fixture.top
    fireEvent.wheel(fixture.viewport, { deltaY: -20 })
    await advance(1000)
    expect(fixture.top).toBe(readingTop)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('keeps an initially short transcript paused after disclosure and later growth', async () => {
    const fixture = createFixture()
    fixture.resizeContent(200)
    await fixture.start()
    act(() => fixture.follow.stopScroll())
    fixture.resizeContent(1000)
    await advance(1000)
    expect(fixture.top).toBe(0)
    expect(fixture.follow.state.isAtBottom).toBe(false)
  })

  test('detaches listeners from a replaced viewport', async () => {
    const fixture = createFixture()
    await fixture.start()
    const oldViewport = fixture.viewport
    const remove = vi.spyOn(oldViewport, 'removeEventListener')
    fixture.replace()
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function))
  })

  test('cancels pending frames and observers on StrictMode unmount', async () => {
    const fixture = createFixture({ strict: true })
    act(() => {
      fixture.follow.scrollToBottom({ wait: 5000, animation: 'instant' })
    })
    await advance(20)
    fixture.unmount()
    await advance(20)
    expect(vi.getTimerCount()).toBe(0)
    expect(ControlledResizeObserver.instances.every(observer => observer.targets.size === 0)).toBe(
      true
    )
  })
})
