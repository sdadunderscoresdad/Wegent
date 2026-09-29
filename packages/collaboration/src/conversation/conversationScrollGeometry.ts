import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { ConversationScrollSnapshot } from './conversationViewportCache'

export function messageAnchors(content: HTMLElement) {
  return Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]'))
}

export function captureReadingPosition(
  viewport: HTMLElement,
  content: HTMLElement,
  messages: WorkbenchMessage[]
): ConversationScrollSnapshot {
  const top = viewport.getBoundingClientRect().top + viewport.clientTop
  const anchors = messageAnchors(content)
  const anchor =
    anchors.find(element => element.getBoundingClientRect().bottom > top) ?? anchors.at(-1)
  const message = messages.find(item => item.id === anchor?.dataset.messageId)
  return {
    schemaVersion: 1,
    mode: 'reading',
    messageId: anchor?.dataset.messageId,
    messageIndex: message?.runtimeMessageIndex ?? undefined,
    offsetWithinAnchorPx: anchor ? top - anchor.getBoundingClientRect().top : 0,
    viewportWidthPx: viewport.clientWidth,
  }
}

export function getReadingPosition(
  viewport: HTMLElement,
  content: HTMLElement,
  snapshot: ConversationScrollSnapshot,
  messages: WorkbenchMessage[]
) {
  const anchors = messageAnchors(content)
  const exact = anchors.find(anchor => anchor.dataset.messageId === snapshot.messageId)
  // A deleted anchor degrades to the nearest loaded transcript message, never the bottom.
  const nearest =
    snapshot.messageIndex === undefined
      ? anchors[0]
      : [...anchors].sort((a, b) => {
          const distance = (element: HTMLElement) => {
            const index = messages.find(
              item => item.id === element.dataset.messageId
            )?.runtimeMessageIndex
            return typeof index === 'number' ? Math.abs(index - snapshot.messageIndex!) : Infinity
          }
          return distance(a) - distance(b)
        })[0]
  const anchor = exact ?? nearest
  if (!anchor) return null
  const top =
    anchor.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top -
    viewport.clientTop +
    viewport.scrollTop +
    (exact ? (snapshot.offsetWithinAnchorPx ?? 0) : 0)
  return Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight))
}
