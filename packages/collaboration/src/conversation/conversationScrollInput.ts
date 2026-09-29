const TOUCH_READING_THRESHOLD_PX = 8

function ownsConversationInput(target: EventTarget | null, viewport: HTMLElement) {
  if (!(target instanceof Element) || !viewport.contains(target)) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
    return false
  for (
    let element: Element | null = target;
    element && element !== viewport;
    element = element.parentElement
  ) {
    if (['auto', 'scroll'].includes(getComputedStyle(element).overflowY)) return false
  }
  return true
}

/** Translate reader input into intent; never write a scroll position here. */
export function subscribeConversationScrollInput(
  viewport: HTMLElement,
  interaction: HTMLElement | null,
  pause: () => void,
  cancelPositioning: () => void
) {
  let gesture: { origin: Touch; previous: Touch; direction: number } | null = null
  const resetTouch = () => {
    gesture = null
  }
  const touchStart = (event: TouchEvent) => {
    gesture =
      event.touches.length === 1 && ownsConversationInput(event.target, viewport)
        ? { origin: event.touches[0], previous: event.touches[0], direction: 0 }
        : null
  }
  const touchMove = (event: TouchEvent) => {
    const current = event.touches[0]
    if (
      !gesture ||
      event.defaultPrevented ||
      event.touches.length !== 1 ||
      current.identifier !== gesture.origin.identifier
    ) {
      resetTouch()
      return
    }
    const direction = Math.sign(current.clientY - gesture.previous.clientY)
    if (direction !== 0 && direction !== gesture.direction) {
      gesture.origin = gesture.previous
      gesture.direction = direction
    }
    gesture.previous = current
    const dx = current.clientX - gesture.origin.clientX
    const dy = current.clientY - gesture.origin.clientY
    // Moving the finger down scrolls toward older messages. Horizontal gestures
    // and a small amount of finger jitter do not express reading intent.
    if (Math.abs(dy) < TOUCH_READING_THRESHOLD_PX || Math.abs(dy) <= Math.abs(dx)) return
    if (dy > 0) {
      resetTouch()
      pause()
    } else cancelPositioning()
  }
  const wheel = (event: WheelEvent) => {
    if (!ownsConversationInput(event.target, viewport)) return
    if (event.deltaY < 0) pause()
    else if (event.deltaY > 0) cancelPositioning()
  }
  const keyboard = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !ownsConversationInput(event.target, viewport)
    )
      return
    const spaceScroll =
      event.key === ' ' &&
      !(event.target as Element).closest('button, a[href], summary, [role="button"]')
    if (['Home', 'PageUp', 'ArrowUp'].includes(event.key) || (spaceScroll && event.shiftKey))
      pause()
    else if (['End', 'PageDown', 'ArrowDown'].includes(event.key) || spaceScroll)
      cancelPositioning()
  }
  const scrollbar = () => pause()
  const scrollbarKeyboard = (event: KeyboardEvent) => {
    if (['Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown'].includes(event.key)) pause()
  }
  viewport.addEventListener('wheel', wheel, { passive: true })
  // React handlers run at the root. Observe bubbling keyboard input afterwards
  // so controls can consume it before it changes the conversation's intent.
  viewport.ownerDocument.addEventListener('keydown', keyboard)
  viewport.addEventListener('touchstart', touchStart, { passive: true })
  viewport.addEventListener('touchmove', touchMove, { passive: true })
  viewport.addEventListener('touchend', resetTouch, { passive: true })
  viewport.addEventListener('touchcancel', resetTouch, { passive: true })
  interaction?.addEventListener('pointerdown', scrollbar)
  interaction?.addEventListener('keydown', scrollbarKeyboard)
  return () => {
    viewport.removeEventListener('wheel', wheel)
    viewport.ownerDocument.removeEventListener('keydown', keyboard)
    viewport.removeEventListener('touchstart', touchStart)
    viewport.removeEventListener('touchmove', touchMove)
    viewport.removeEventListener('touchend', resetTouch)
    viewport.removeEventListener('touchcancel', resetTouch)
    interaction?.removeEventListener('pointerdown', scrollbar)
    interaction?.removeEventListener('keydown', scrollbarKeyboard)
  }
}
