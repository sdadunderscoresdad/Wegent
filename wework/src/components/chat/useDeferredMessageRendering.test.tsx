import { useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useDeferredMessageRendering } from '../../../../packages/collaboration/src/conversation/useDeferredMessageRendering'

let height = 1800
let resize: ResizeObserverCallback
const disconnect = vi.fn()

function Host({ messages }: { messages: { id: string; defer: boolean }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useDeferredMessageRendering(ref, messages)
  return messages.length ? (
    <div ref={ref}>
      {messages.map(message => (
        <article
          key={message.id}
          data-testid={message.id}
          data-message-id={message.id}
          data-defer-offscreen-rendering={message.defer || undefined}
        />
      ))}
    </div>
  ) : null
}

beforeEach(() => {
  height = 1800
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe() {}
      disconnect = disconnect
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { height: this.hasAttribute('data-message-id') ? height : 0, width: 800 } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  disconnect.mockClear()
})

test('measures actual history height and releases containment when history becomes active', () => {
  const { rerender } = render(
    <Host
      messages={[
        { id: 'history', defer: true },
        { id: 'live', defer: false },
      ]}
    />
  )
  expect(screen.getByTestId('history').style.containIntrinsicBlockSize).toBe('auto 1800px')
  expect(screen.getByTestId('history').dataset.offscreenReady).toBe('true')
  expect(screen.getByTestId('live').dataset.offscreenReady).toBeUndefined()
  rerender(<Host messages={[{ id: 'history', defer: false }]} />)
  expect(screen.getByTestId('history').style.containIntrinsicBlockSize).toBe('')
  expect(screen.getByTestId('history').dataset.offscreenReady).toBeUndefined()
})

test('binds after asynchronous history arrival and invalidates heights only on width changes', () => {
  const { rerender, unmount } = render(<Host messages={[]} />)
  rerender(<Host messages={[{ id: 'history', defer: true }]} />)
  const notifyWidth = (width: number) =>
    act(() =>
      resize(
        [{ borderBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry],
        {} as ResizeObserver
      )
    )
  height = 2400
  notifyWidth(600)
  expect(screen.getByTestId('history').style.containIntrinsicBlockSize).toBe('auto 2400px')
  height = 3000
  notifyWidth(600)
  expect(screen.getByTestId('history').style.containIntrinsicBlockSize).toBe('auto 2400px')
  notifyWidth(500)
  expect(screen.getByTestId('history').style.containIntrinsicBlockSize).toBe('auto 3000px')
  unmount()
  expect(disconnect).toHaveBeenCalled()
})

test('does not cache a hidden pane zero height and measures when it becomes visible', () => {
  height = 0
  render(<Host messages={[{ id: 'history', defer: true }]} />)
  expect(screen.getByTestId('history').dataset.offscreenReady).toBeUndefined()
  height = 1800
  act(() =>
    resize(
      [{ borderBoxSize: [{ inlineSize: 700 }] } as unknown as ResizeObserverEntry],
      {} as ResizeObserver
    )
  )
  expect(screen.getByTestId('history').style.containIntrinsicBlockSize).toBe('auto 1800px')
})
