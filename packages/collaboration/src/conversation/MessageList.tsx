import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { RequestUserInputResponse, TurnFileChangesSummary } from '@wegent/chat-core/runtime'
import type {
  RuntimeConversationTurn,
  SubagentBlock,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import { stripPluginWorkspaceResultMarkers } from '@wegent/chat-core/plugin-workspace-result'
import type { MarkdownFileOpenOptions } from '../markdown/MarkdownServices'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import type { UserMessageServices } from './UserMessage'
import { MessageRow } from './MessageRow'
import {
  isCancelledAssistantMessage,
  shouldHideFailedAssistantContent,
  getDisplayProcessingBlocks,
} from './assistantMessagePresentation'
import { AssistantThinkingIndicator } from './AssistantThinkingIndicator'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import type { AssistantPlanOpenRequest } from './AssistantPlanCard'
import { SelectionActionsPopover } from './SelectionActionsPopover'

export interface MessageListProps {
  userMessageServices: UserMessageServices
  renderVisualization?: (
    part: { file: string; mode?: 'wide'; title?: string },
    message: WorkbenchMessage
  ) => ReactNode
  messages: WorkbenchMessage[]
  turns?: RuntimeConversationTurn[]
  onBeforeUserMessageToggle?: () => void
  className?: string
  conversationKey?: string | number | null
  isWaitingForAssistant?: boolean
  devices?: Array<{ device_id: string; status: string }>
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (subtaskId: string, changes?: TurnFileChangesSummary) => Promise<string>
  onRevertFileChanges?: (
    subtaskId: string,
    changes?: TurnFileChangesSummary
  ) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: string
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  fileChangesDiffPreviewDisabledSubtaskId?: string | null
  onOpenWorkspaceFile?: (path: string, options?: MarkdownFileOpenOptions) => void
  onOpenLocalSkillFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
  onOpenSubagent?: (block: SubagentBlock) => void
  onEditLastUserMessage?: (
    message: WorkbenchMessage,
    content: string
  ) => Promise<boolean | void> | boolean | void
  canEditLastUserMessage?: boolean
  onForkMessage?: (message: WorkbenchMessage) => Promise<void> | void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  onAddSelectionToConversation?: (text: string) => void
  onAskSelectionInSidebar?: (text: string) => void
  renderGapAfterMessage?: (
    message: WorkbenchMessage,
    nextMessage: WorkbenchMessage | undefined
  ) => ReactNode
}

interface MessageTextSelection {
  text: string
  left: number
  top: number
  conversationKey?: string | number | null
}

const EMPTY_TURNS: RuntimeConversationTurn[] = []
const EMPTY_DEVICES: NonNullable<MessageListProps['devices']> = []

export const MessageList = memo(function MessageList({
  userMessageServices,
  renderVisualization,
  messages,
  turns = EMPTY_TURNS,
  onBeforeUserMessageToggle,
  className,
  conversationKey,
  isWaitingForAssistant = false,
  devices = EMPTY_DEVICES,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  fileChangesDiffPreviewDisabledSubtaskId,
  onOpenWorkspaceFile,
  onOpenLocalSkillFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onOpenSubagent,
  onEditLastUserMessage,
  canEditLastUserMessage = false,
  onForkMessage,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onAddSelectionToConversation,
  onAskSelectionInSidebar,
  renderGapAfterMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [textSelection, setTextSelection] = useState<MessageTextSelection | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [submittingEditMessageId, setSubmittingEditMessageId] = useState<string | null>(null)
  const submitMessageEdit = useCallback(
    async (message: WorkbenchMessage, content: string) => {
      if (!onEditLastUserMessage) return false
      setSubmittingEditMessageId(message.id)
      try {
        const result = await onEditLastUserMessage(message, content)
        if (result !== false) setEditingMessageId(null)
        return result
      } finally {
        setSubmittingEditMessageId(current => (current === message.id ? null : current))
      }
    },
    [onEditLastUserMessage]
  )
  const visibleMessages = useMemo(() => messages.filter(shouldRenderMessage), [messages])
  const runtimeTurnsById = useMemo(
    () => new Map(turns.flatMap(turn => (turn.id ? [[turn.id, turn] as const] : []))),
    [turns]
  )
  const lastAssistantMessageIdByTurn = useMemo(() => {
    const result = new Map<string, string>()
    for (const message of visibleMessages) {
      if (message.role === 'assistant' && message.turnId) result.set(message.turnId, message.id)
    }
    return result
  }, [visibleMessages])
  const editableLastUserMessageId = useMemo(
    () =>
      editableLastUserMessage(visibleMessages, canEditLastUserMessage && !!onEditLastUserMessage)
        ?.id ?? null,
    [canEditLastUserMessage, onEditLastUserMessage, visibleMessages]
  )
  const shouldShowWaitingIndicator =
    isWaitingForAssistant &&
    !messages.some(message => message.role === 'assistant' && message.status === 'streaming')

  useEffect(() => {
    if (!onAddSelectionToConversation || !onAskSelectionInSidebar) return
    let frame: number | undefined
    const update = (preserve = false) => {
      const selection = document.getSelection()
      const root = listRef.current
      if (!selection || !root || selection.isCollapsed || !selection.rangeCount) {
        if (!preserve) setTextSelection(null)
        return
      }
      const range = selection.getRangeAt(0)
      const bodies = Array.from(
        root.querySelectorAll<HTMLElement>('[data-message-selectable-text]')
      ).filter(element => selectedTextWithinElement(range, element).trim())
      const text = selection.toString().trim()
      if (bodies.length !== 1 || !text) {
        setTextSelection(null)
        return
      }
      const rect = range.getBoundingClientRect()
      setTextSelection({
        text,
        left: Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120),
        top: Math.max(rect.top - 8, 44),
        conversationKey,
      })
    }
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => update(true))
    }
    const finalize = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="message-selection-actions"]')
      )
        return
      update()
    }
    const scroll = () => update(true)
    const events = ['pointerup', 'pointercancel', 'mouseup', 'keyup']
    for (const event of events) document.addEventListener(event, finalize)
    document.addEventListener('selectionchange', schedule)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', finalize)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      for (const event of events) document.removeEventListener(event, finalize)
      document.removeEventListener('selectionchange', schedule)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', finalize)
    }
  }, [conversationKey, onAddSelectionToConversation, onAskSelectionInSidebar])

  const applySelectionAction = (action: (text: string) => void) => {
    if (!textSelection) return
    action(textSelection.text)
    document.getSelection()?.removeAllRanges()
    setTextSelection(null)
  }
  if (!visibleMessages.length && !shouldShowWaitingIndicator) return null

  return (
    <div
      ref={listRef}
      className={cn(
        'mx-auto flex min-w-0 flex-col gap-4 pb-2 pt-8',
        !className && 'w-full max-w-3xl px-6',
        className
      )}
    >
      {textSelection && textSelection.conversationKey === conversationKey && (
        <SelectionActionsPopover
          position={{ left: textSelection.left, top: textSelection.top }}
          onAddToConversation={() => applySelectionAction(onAddSelectionToConversation!)}
          onAskInSidebar={() => applySelectionAction(onAskSelectionInSidebar!)}
        />
      )}
      {visibleMessages.map((message, index) => (
        <Fragment key={message.id}>
          <MessageRow
            message={message}
            runtimeTurn={
              message.turnId && lastAssistantMessageIdByTurn.get(message.turnId) === message.id
                ? runtimeTurnsById.get(message.turnId)
                : undefined
            }
            userMessageServices={userMessageServices}
            renderVisualization={renderVisualization}
            conversationKey={conversationKey}
            isActiveTurn={isWaitingForAssistant && index === visibleMessages.length - 1}
            devices={devices}
            onBeforeUserMessageToggle={onBeforeUserMessageToggle}
            onRetryFailedMessage={onRetryFailedMessage}
            onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
            onLoadFileChangesDiff={onLoadFileChangesDiff}
            onRevertFileChanges={onRevertFileChanges}
            onOpenFileChangesReview={onOpenFileChangesReview}
            fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            onOpenLocalSkillFile={onOpenLocalSkillFile}
            onRequestUserInputSubmit={onRequestUserInputSubmit}
            onRequestUserInputIgnore={onRequestUserInputIgnore}
            onOpenAssistantPlan={onOpenAssistantPlan}
            onOpenSubagent={onOpenSubagent}
            onEditLastUserMessage={submitMessageEdit}
            onForkMessage={onForkMessage}
            hideRequestUserInputBlocks={hideRequestUserInputBlocks}
            hiddenRequestUserInputIds={hiddenRequestUserInputIds}
            editable={message.id === editableLastUserMessageId}
            editing={message.id === editableLastUserMessageId && editingMessageId === message.id}
            editSubmitting={submittingEditMessageId === message.id}
            onEditingMessageChange={setEditingMessageId}
          />
          {renderGapAfterMessage?.(message, visibleMessages[index + 1])}
        </Fragment>
      ))}
      {shouldShowWaitingIndicator && (
        <article className="min-w-0" data-testid="message-assistant-waiting">
          <AssistantThinkingIndicator />
        </article>
      )}
    </div>
  )
})

function selectedTextWithinElement(range: Range, element: HTMLElement): string {
  if (!range.intersectsNode(element)) return ''
  const intersection = document.createRange()
  intersection.selectNodeContents(element)
  if (intersection.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
    intersection.setStart(range.startContainer, range.startOffset)
  }
  if (intersection.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
    intersection.setEnd(range.endContainer, range.endOffset)
  }
  return intersection.toString()
}

function shouldRenderMessage(message: WorkbenchMessage): boolean {
  if (message.role !== 'assistant') return true
  if (message.status === 'streaming' || message.status === 'failed') return true
  if (isCancelledAssistantMessage(message) || message.fileChanges) return true
  if (message.references?.length || message.memoryCitations?.length) return true
  const content = shouldHideFailedAssistantContent(message)
    ? ''
    : stripPluginWorkspaceResultMarkers(message.content)
  return !!content.trim() || getDisplayProcessingBlocks(message.blocks).length > 0
}

function editableLastUserMessage(messages: WorkbenchMessage[], canEdit: boolean) {
  if (!canEdit) return null
  let index = messages.length - 1
  while (index >= 0 && messages[index].role !== 'user') index--
  if (index < 0) return null
  const following = messages.slice(index + 1)
  return following.some(message => message.role === 'assistant') &&
    !following.some(message => message.status === 'streaming')
    ? messages[index]
    : null
}
