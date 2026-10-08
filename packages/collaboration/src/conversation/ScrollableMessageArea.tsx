import { ArrowDown } from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useConversationTranslation } from './ConversationTranslation'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { MessageList, type MessageListProps } from './MessageList'
import { MessageTurnNavigation } from './MessageTurnNavigation'
import { useConversationScrollController } from './useConversationScrollController'
import {
  RuntimeTranscriptGapMarker,
  runtimeTranscriptGapBetween,
  runtimeTranscriptGapKey,
} from './RuntimeTranscriptGapMarker'
import type { RuntimeTranscriptGap, ScrollableMessageAreaProps } from './scrollableMessageTypes'

export const ScrollableMessageArea = memo(function ScrollableMessageArea(
  props: ScrollableMessageAreaProps
) {
  // A session change invalidates observers, pending loads and viewport commands together.
  return <ConversationPane key={props.conversationKey ?? 'keyless'} {...props} />
})

function ConversationPane(props: ScrollableMessageAreaProps) {
  const {
    loading,
    hasMoreBefore,
    loadingMoreBefore,
    turnNavigation,
    loadedTranscriptRanges,
    className,
    scrollerClassName,
    contentClassName,
    messageListClassName,
    contentFooter,
    contentFooterClassName,
    stickyFooter,
    stickyFooterClassName,
    scrollButtonClassName,
    scrollTestId = 'chat-message-scroll-area',
    externalScrollRef,
    turnNavigationPortalTarget,
    onLoadMoreBefore,
    onLoadTurnNavigationItem,
    onLoadTranscriptGap,
    renderGapAfterMessage,
  } = props
  const { t, translate } = useConversationTranslation()
  const {
    internalScrollRef,
    scrollRef,
    contentRef,
    bindContent,
    pause,
    resume,
    stopForNavigation,
    position,
    positionReady,
    showScrollButton,
  } = useConversationScrollController(props)
  const [navigationLoading, setNavigationLoading] = useState(false)
  const [gapLoading, setGapLoading] = useState<string | null>(null)
  const pendingGap = useRef<string | null>(null)
  const attemptedGaps = useRef(new Set<string>())
  const active = useRef(true)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const loadGap = useCallback(
    async (gap: RuntimeTranscriptGap, reason: 'visible' | 'click') => {
      const key = runtimeTranscriptGapKey(gap)
      if (
        !onLoadTranscriptGap ||
        pendingGap.current ||
        (reason === 'visible' && attemptedGaps.current.has(key))
      )
        return
      attemptedGaps.current.add(key)
      pendingGap.current = key
      setGapLoading(key)
      try {
        await onLoadTranscriptGap(gap)
      } catch (error) {
        // The marker remains an explicit retry action; host transcript errors stay visible.
        console.warn('[Wework] Conversation transcript gap load failed', {
          gap,
          error,
        })
      } finally {
        if (active.current) {
          pendingGap.current = null
          setGapLoading(null)
        }
      }
    },
    [onLoadTranscriptGap]
  )
  const renderGap = useCallback<NonNullable<MessageListProps['renderGapAfterMessage']>>(
    (message, next) => {
      const gap = runtimeTranscriptGapBetween(message, next, loadedTranscriptRanges)
      const transcriptGap = gap ? (
        <RuntimeTranscriptGapMarker
          key={runtimeTranscriptGapKey(gap)}
          gap={gap}
          loading={gapLoading === runtimeTranscriptGapKey(gap)}
          scrollRef={scrollRef}
          onLoad={onLoadTranscriptGap ? loadGap : undefined}
        />
      ) : null
      const customGap = renderGapAfterMessage?.(message, next)
      if (!transcriptGap) return customGap
      if (!customGap) return transcriptGap
      return (
        <>
          {transcriptGap}
          {customGap}
        </>
      )
    },
    [
      gapLoading,
      loadGap,
      loadedTranscriptRanges,
      onLoadTranscriptGap,
      scrollRef,
      renderGapAfterMessage,
    ]
  )
  const navigationState = useCallback(
    (pending: boolean) => {
      if (pending) stopForNavigation()
      setNavigationLoading(pending)
    },
    [stopForNavigation]
  )
  const navigationTarget = useCallback(
    (messageId: string | null) => {
      if (messageId) stopForNavigation()
    },
    [stopForNavigation]
  )
  const scrollButton = showScrollButton ? (
    <button
      type="button"
      data-testid="scroll-to-bottom-button"
      onClick={resume}
      aria-label={t('workbench.scroll_to_bottom')}
      className={cn(
        'absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-text-primary shadow-sm hover:bg-muted',
        scrollButtonClassName
      )}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  ) : null

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      {navigationLoading && (
        <div
          data-testid="message-turn-navigation-loading"
          className="pointer-events-none absolute left-1/2 top-5 z-30 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-text-secondary"
        >
          {t('message_navigation.loading_target')}
        </div>
      )}
      <div
        ref={internalScrollRef}
        data-testid={scrollTestId}
        data-scroll-origin="top"
        data-conversation-position={positionReady ? 'ready' : 'pending'}
        className={cn(
          'flex h-full flex-col',
          externalScrollRef ? 'min-h-full' : 'overflow-y-auto',
          scrollerClassName
        )}
        onClickCapture={event => {
          if (
            event.target instanceof Element &&
            event.target.closest('button[aria-expanded], summary')
          )
            pause()
        }}
      >
        <div ref={bindContent} className="flex min-h-full min-w-0 flex-1 shrink-0 flex-col">
          <div
            data-testid={`${scrollTestId}-content`}
            className={cn('min-w-0 flex-1 shrink-0', contentClassName)}
            style={{
              visibility: props.messages.length && !positionReady ? 'hidden' : undefined,
            }}
          >
            {!props.messages.length ? (
              loading ? (
                <div
                  data-testid="chat-loading-state"
                  className="flex min-h-full items-center justify-center px-6 py-16 text-center text-sm text-text-muted"
                >
                  {t('workbench.loading_conversation')}
                </div>
              ) : (
                <div
                  data-testid="chat-empty-state"
                  className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center"
                >
                  <h2 className="text-sm font-medium text-text-primary">
                    {t('workbench.empty_conversation_title')}
                  </h2>
                  <p className="mt-2 max-w-sm text-xs leading-5 text-text-muted">
                    {t('workbench.empty_conversation_description')}
                  </p>
                </div>
              )
            ) : (
              <>
                {hasMoreBefore && (
                  <div className="flex justify-center px-4 pb-2 pt-4">
                    <button
                      type="button"
                      data-testid="load-older-runtime-transcript-button"
                      disabled={loadingMoreBefore || !onLoadMoreBefore}
                      onClick={() => {
                        void onLoadMoreBefore?.()
                      }}
                      className="flex h-11 min-w-[44px] items-center justify-center rounded-md border border-border bg-surface px-4 text-xs font-medium text-text-secondary hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                    >
                      {t(
                        loadingMoreBefore
                          ? 'workbench.loading_older_messages'
                          : 'workbench.load_older_messages'
                      )}
                    </button>
                  </div>
                )}
                <MessageList
                  {...props}
                  className={messageListClassName}
                  onBeforeUserMessageToggle={pause}
                  renderGapAfterMessage={renderGap}
                />
                {contentFooter && (
                  <div
                    data-testid={`${scrollTestId}-content-footer`}
                    className={contentFooterClassName}
                  >
                    {contentFooter}
                  </div>
                )}
              </>
            )}
          </div>
          {stickyFooter && (
            <div
              data-testid={`${scrollTestId}-sticky-footer`}
              className={cn('sticky bottom-0 z-10 w-full shrink-0', stickyFooterClassName)}
            >
              <div className="relative h-0">{scrollButton}</div>
              {stickyFooter}
            </div>
          )}
        </div>
      </div>
      <MessageTurnNavigation
        translate={translate}
        messages={props.messages}
        turnNavigation={turnNavigation}
        scrollRef={scrollRef}
        contentRef={contentRef}
        onScrollToPosition={position}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
        onNavigationLoadStateChange={navigationState}
        onNavigationScrollTargetChange={navigationTarget}
        portalTarget={turnNavigationPortalTarget}
      />
      {!stickyFooter && scrollButton}
    </div>
  )
}
