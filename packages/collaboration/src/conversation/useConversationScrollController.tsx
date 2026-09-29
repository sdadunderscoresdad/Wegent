import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useConversationFollow } from './useConversationFollow'
import {
  cacheConversationScrollSnapshot,
  getConversationScrollSnapshot,
} from './conversationViewportCache'
import {
  captureReadingPosition,
  messageAnchors,
  getReadingPosition,
} from './conversationScrollGeometry'
import { subscribeConversationScrollInput } from './conversationScrollInput'
import type { ScrollableMessageAreaProps } from './scrollableMessageTypes'

/** Business intents only. All resize following and animation stay in use-stick-to-bottom. */
export function useConversationScrollController({
  messages,
  loading,
  conversationKey,
  externalScrollRef,
  externalScrollInteractionRef,
  viewportActionsRef,
  autoScrollSuspended,
  initialScrollPosition = 'restore',
  turnNavigation,
  onLoadTurnNavigationItem,
}: ScrollableMessageAreaProps) {
  const {
    state: followState,
    scrollRef: bindScroll,
    contentRef: bindFollowContent,
    stopScroll,
    scrollToBottom,
    setScrollPosition,
    isNearBottom,
  } = useConversationFollow()
  const internalScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [binding, setBinding] = useState<{
    scrollRef: RefObject<HTMLDivElement | null>
    interaction: HTMLElement | null
  }>({ scrollRef: { current: null }, interaction: null })
  const contentRef = useRef<HTMLDivElement>(null)
  const bindContent = useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element
      bindFollowContent(element)
    },
    [bindFollowContent]
  )
  const initialized = useRef(false)
  const [positionReady, setPositionReady] = useState(false)
  const generation = useRef(0)
  const [restoreReady, setRestoreReady] = useState(false)
  const restoreStarted = useRef(false)
  const suspendedFollowing = useRef<boolean | null>(null)
  const key = conversationKey == null ? null : String(conversationKey)
  const [snapshot] = useState(() =>
    key && initialScrollPosition === 'restore' ? getConversationScrollSnapshot(key) : undefined
  )
  const latest = useRef({ messages, loading })
  useLayoutEffect(() => {
    latest.current = { messages, loading }
  })

  const save = useCallback(() => {
    const viewport = scrollRef.current
    const content = contentRef.current
    if (
      !key ||
      !viewport ||
      !content ||
      !initialized.current ||
      latest.current.loading ||
      latest.current.messages.length === 0
    )
      return
    cacheConversationScrollSnapshot(
      key,
      (suspendedFollowing.current ?? followState.isAtBottom)
        ? { schemaVersion: 1, mode: 'following' }
        : captureReadingPosition(viewport, content, latest.current.messages)
    )
  }, [followState, key])
  const cancelPositioning = useCallback(() => {
    initialized.current = true
    setPositionReady(true)
    generation.current++
    scrollRef.current?.dispatchEvent(new Event('conversation-user-takeover'))
  }, [])
  const pause = useCallback(() => {
    cancelPositioning()
    suspendedFollowing.current = null
    stopScroll()
  }, [cancelPositioning, stopScroll])
  const resume = useCallback(() => {
    cancelPositioning()
    if (autoScrollSuspended) {
      suspendedFollowing.current = true
      return
    }
    suspendedFollowing.current = null
    void scrollToBottom('instant')
  }, [autoScrollSuspended, cancelPositioning, scrollToBottom])
  const stopForNavigation = useCallback(() => {
    initialized.current = true
    setPositionReady(true)
    generation.current++
    suspendedFollowing.current = null
    stopScroll()
  }, [stopScroll])
  const position = useCallback(
    (top: number) => {
      stopForNavigation()
      setScrollPosition(top)
    },
    [setScrollPosition, stopForNavigation]
  )
  useImperativeHandle(viewportActionsRef, () => ({ follow: resume }), [resume])

  // Object refs can acquire a different element without changing identity.
  // Only publish a binding when either actual node changed.
  const syncBinding = () => {
    const viewport = externalScrollRef ? externalScrollRef.current : internalScrollRef.current
    const interaction = externalScrollInteractionRef?.current ?? null
    if (scrollRef.current !== viewport) {
      generation.current++
      scrollRef.current = viewport
      bindScroll(viewport)
    }
    if (binding.scrollRef.current !== viewport || binding.interaction !== interaction) {
      setBinding({ scrollRef: { current: viewport }, interaction })
    }
  }
  useLayoutEffect(syncBinding)
  // Ancestor object refs can be assigned after child layout effects. Keep the
  // transcript unpainted until this binding and its initial positioning commit.
  useEffect(syncBinding)

  useEffect(
    () => () => {
      generation.current++
      bindScroll(null)
      scrollRef.current = null
    },
    [bindScroll]
  )

  useLayoutEffect(
    () => () => {
      save()
      generation.current++
    },
    [save]
  )

  useLayoutEffect(() => {
    if (autoScrollSuspended) {
      if (suspendedFollowing.current === null) suspendedFollowing.current = followState.isAtBottom
      stopScroll()
      return
    }
    if (suspendedFollowing.current !== null) {
      const wasFollowing = suspendedFollowing.current
      suspendedFollowing.current = null
      if (initialized.current && wasFollowing) resume()
    }
    if (
      initialized.current ||
      loading ||
      !messages.length ||
      !scrollRef.current ||
      !contentRef.current
    )
      return
    const viewport = scrollRef.current
    const content = contentRef.current
    if (snapshot && snapshot.mode === 'reading') {
      const found = messageAnchors(content).some(
        anchor => anchor.dataset.messageId === snapshot.messageId
      )
      const target = turnNavigation?.find(
        item =>
          item.id === snapshot.messageId ||
          (snapshot.messageIndex !== undefined && item.messageIndex === snapshot.messageIndex)
      )
      if (!found && target && onLoadTurnNavigationItem && !restoreReady) {
        if (!restoreStarted.current) {
          restoreStarted.current = true
          const operation = generation.current
          void Promise.resolve()
            .then(() => {
              if (operation === generation.current) return onLoadTurnNavigationItem(target)
            })
            .then(
              () => {
                if (operation === generation.current) setRestoreReady(true)
              },
              error => {
                if (operation !== generation.current) return
                stopScroll()
                // Let the host's load error remain visible without saving a
                // replacement snapshot for a restoration that never completed.
                setPositionReady(true)
                console.warn('[Wework] Conversation reading position load failed', {
                  messageId: snapshot.messageId,
                  error,
                })
              }
            )
        }
        return
      }
      position(getReadingPosition(viewport, content, snapshot, messages) ?? viewport.scrollTop)
    } else {
      // Initial placement must finish before revealing the transcript. The
      // dependency's instant follow still schedules its write on a later frame.
      setScrollPosition(Math.max(0, viewport.scrollHeight - viewport.clientHeight))
      resume()
    }
  }, [
    autoScrollSuspended,
    binding,
    followState,
    stopScroll,
    loading,
    messages,
    onLoadTurnNavigationItem,
    position,
    restoreReady,
    resume,
    snapshot,
    setScrollPosition,
    turnNavigation,
  ])

  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const unsubscribe = subscribeConversationScrollInput(
      viewport,
      binding.interaction,
      pause,
      cancelPositioning
    )
    viewport.addEventListener('scroll', save, { passive: true })
    return () => {
      unsubscribe()
      viewport.removeEventListener('scroll', save)
    }
  }, [binding, cancelPositioning, pause, save])

  return {
    internalScrollRef,
    scrollRef: binding.scrollRef,
    contentRef,
    bindContent,
    pause,
    resume,
    stopForNavigation,
    position,
    positionReady,
    showScrollButton: !isNearBottom && !followState.isAtBottom,
  }
}
