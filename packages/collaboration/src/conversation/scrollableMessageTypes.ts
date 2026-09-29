import type { ReactNode, RefObject } from 'react'
import type { RuntimeTurnNavigationItem } from '@wegent/chat-core/runtime'
import type { MessageListProps } from './MessageList'

export interface RuntimeTranscriptGap {
  start: number
  end: number
}
export type RuntimeTranscriptRange = RuntimeTranscriptGap

export interface ConversationViewportActions {
  follow: () => void
}

export interface ScrollableMessageAreaProps extends Omit<
  MessageListProps,
  'renderGapAfterMessage'
> {
  loading?: boolean
  hasMoreBefore?: boolean
  loadingMoreBefore?: boolean
  turnNavigation?: RuntimeTurnNavigationItem[]
  loadedTranscriptRanges?: RuntimeTranscriptRange[]
  scrollerClassName?: string
  contentClassName?: string
  messageListClassName?: string
  contentFooter?: ReactNode
  contentFooterClassName?: string
  stickyFooter?: ReactNode
  stickyFooterClassName?: string
  scrollButtonClassName?: string
  scrollTestId?: string
  externalScrollRef?: RefObject<HTMLDivElement | null>
  externalScrollInteractionRef?: RefObject<HTMLElement | null>
  viewportActionsRef?: RefObject<ConversationViewportActions | null>
  turnNavigationPortalTarget?: Element | null
  autoScrollSuspended?: boolean
  onLoadMoreBefore?: () => Promise<void> | void
  onLoadTurnNavigationItem?: (item: RuntimeTurnNavigationItem) => Promise<void> | void
  onLoadTranscriptGap?: (gap: RuntimeTranscriptGap) => Promise<void> | void
  initialScrollPosition?: 'restore' | 'latest'
}
