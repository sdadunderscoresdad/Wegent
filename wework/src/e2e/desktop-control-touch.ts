/** Send touch input through the real DOM handlers without emulating layout or scrolling. */
export function dispatchDesktopControlTouchGesture(element: HTMLElement, value: string) {
  const points: Array<{ x: number; y: number }> = JSON.parse(value)
  if (
    !Array.isArray(points) ||
    points.length < 2 ||
    points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
  )
    throw new Error('touchGesture requires at least two finite {x, y} points')
  const rect = element.getBoundingClientRect()
  for (const [index, point] of points.entries()) {
    const touch = new Touch({
      identifier: 1,
      target: element,
      clientX: rect.left + point.x,
      clientY: rect.top + point.y,
    })
    element.dispatchEvent(
      new TouchEvent(index === 0 ? 'touchstart' : 'touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      })
    )
    if (index === points.length - 1) {
      element.dispatchEvent(
        new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [touch],
        })
      )
    }
  }
}
