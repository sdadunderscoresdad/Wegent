import { useCallback, useLayoutEffect, type RefObject } from 'react'

/** Keep real geometry before allowing the browser to skip historical content. */
export function useDeferredMessageRendering(
  listRef: RefObject<HTMLDivElement | null>,
  messages: readonly unknown[]
) {
  const hasMessages = messages.length > 0
  const measure = useCallback(
    (reset = false) => {
      const rows = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []
      )
      // Invalidate all sizes together before measuring after a width change.
      for (const row of rows) {
        if (reset || !row.hasAttribute('data-defer-offscreen-rendering')) {
          delete row.dataset.offscreenReady
          row.style.removeProperty('contain-intrinsic-block-size')
        }
      }
      const pending = rows.filter(
        row => row.hasAttribute('data-defer-offscreen-rendering') && !row.dataset.offscreenReady
      )
      // Batch reads before writes: enabling containment per row while reading the
      // next row would force a separate layout for every message.
      const heights = pending.map(row => row.getBoundingClientRect().height)
      pending.forEach((row, index) => {
        if (heights[index] <= 0) return
        row.style.containIntrinsicBlockSize = `auto ${heights[index]}px`
        row.dataset.offscreenReady = 'true'
      })
    },
    [listRef]
  )

  useLayoutEffect(() => measure(), [measure, messages])
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    let width = list.getBoundingClientRect().width
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.borderBoxSize[0]?.inlineSize
      if (nextWidth === undefined || nextWidth <= 0 || nextWidth === width) return
      width = nextWidth
      measure(true)
    })
    observer.observe(list, { box: 'border-box' })
    return () => observer.disconnect()
  }, [hasMessages, listRef, measure])
}
