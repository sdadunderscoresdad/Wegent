export function getDistanceFromBottom(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
}

export function getScrollViewportBounds(element: HTMLElement) {
  return {
    startPx: element.scrollTop,
    endPx: element.scrollTop + element.clientHeight,
  }
}

export function getContentPositionForViewportY(element: HTMLElement, viewportY: number) {
  return Math.max(
    0,
    element.scrollTop + viewportY - element.getBoundingClientRect().top - element.clientTop
  )
}
