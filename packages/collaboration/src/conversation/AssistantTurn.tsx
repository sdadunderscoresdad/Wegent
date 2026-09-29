import { useMemo, useState } from 'react'
import type {
  Attachment,
  RequestUserInputResponse,
  RequestUserInputPayload,
  TurnFileChangesSummary,
} from '@wegent/chat-core/runtime'
import type {
  WorkbenchMessage,
  SubagentBlock,
  RuntimeConversationTurn,
} from '@wegent/chat-core/runtime-conversation'
import { getRuntimeMessageActiveThinking } from '@wegent/chat-core/runtime-thinking'
import { stripPluginWorkspaceResultMarkers } from '@wegent/chat-core/plugin-workspace-result'
import { type AssistantMarkdownProps } from '../markdown/AssistantMarkdown'
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from '../markdown/MarkdownServices'
import type { AttachmentImageServices } from '../issue-detail/AttachmentImageView'
import { useConversationTranslation } from './ConversationTranslation'
import { AssistantThinkingIndicator } from './AssistantThinkingIndicator'
import { AssistantTurnTimeline } from './AssistantTurnTimeline'
import { getFileEditDurationsBySourceBlock } from './blocks/fileEditDurations'
import { ProcessingDurationLabel } from './ProcessingDurationLabel'
import { WebSearchSourcesChip } from './blocks/WebSearchSources'
import { getWebSearchSourceItems } from './blocks/webSearchActivity'
import { CodexMemoryCitations, CodexReferenceList } from './CodexTurnArtifacts'
import { getAssistantReferences } from './codexReferences'
import { FileChangesCard } from './FileChangesCard'
import type { AssistantPlanOpenRequest } from './AssistantPlanCard'
import { MessageHoverActions } from './MessageHoverActions'
import { AssistantErrorCard } from './AssistantErrorCard'
import { getGeneratedImages, GeneratedImageGallery } from './GeneratedImageGallery'
import {
  getMessageTimestampMs,
  getStoppedElapsedDuration,
  getProcessingSummaryStartMs,
  isCancelledAssistantMessage,
  isCancelledPlaceholderContent,
  shouldHideFailedAssistantContent,
  getDisplayProcessingBlocks,
  getWebSearchToolBlocks,
  getMessageDisplayStateKey,
  hasRunningProcessingBlocks,
  hasProcessingDisplayBlock,
  hasTrailingCompletedProcessText,
  shouldShowAssistantThinkingIndicator,
} from './assistantMessagePresentation'

export function AssistantMessage({
  imageServices,
  renderVisualization,
  message,
  runtimeTurn,
  conversationKey,
  isActiveTurn = false,
  devices,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  fileChangesDiffPreviewDisabledSubtaskId,
  onOpenWorkspaceFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onOpenSubagent,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onFork,
}: {
  imageServices: AttachmentImageServices<Attachment>
  renderVisualization?: AssistantMarkdownProps['renderVisualization']
  message: WorkbenchMessage
  runtimeTurn?: RuntimeConversationTurn
  conversationKey?: string | number | null
  isActiveTurn?: boolean
  devices: Array<{ device_id: string; status: string }>
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary
  ) => Promise<string>
  onRevertFileChanges?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary
  ) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: string
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  fileChangesDiffPreviewDisabledSubtaskId?: string | null
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
  onOpenSubagent?: (block: SubagentBlock) => void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  onFork?: () => Promise<void> | void
}) {
  const { t } = useConversationTranslation()
  const isCancelled = isCancelledAssistantMessage(message)
  const stoppedElapsedDuration =
    isCancelled && message.stoppedNotice !== false
      ? getStoppedElapsedDuration(message, runtimeTurn)
      : null
  const shouldShowStoppedNotice = isCancelled && message.stoppedNotice !== false
  const shouldHideContent =
    shouldHideFailedAssistantContent(message) ||
    (isCancelled && isCancelledPlaceholderContent(message.content))
  const visibleContent = shouldHideContent ? '' : stripPluginWorkspaceResultMarkers(message.content)
  const hiddenErrorContent =
    message.status === 'failed' && shouldHideContent ? message.content.trim() : undefined
  const displayBlocks = useMemo(
    () => getDisplayProcessingBlocks(message.blocks, isCancelled, visibleContent),
    [isCancelled, message.blocks, visibleContent]
  )
  const fileEditDurationsBySourceBlock = useMemo(
    () => getFileEditDurationsBySourceBlock(displayBlocks),
    [displayBlocks]
  )
  const hasBlocks = displayBlocks.length > 0
  const hasProcessingActivity =
    hasBlocks || message.blocks?.some(block => block.type === 'thinking')
  const hasVisibleContent = Boolean(visibleContent.trim())
  const isStreaming = !isCancelled && message.status === 'streaming'
  const activeThinkingContent = isStreaming ? getRuntimeMessageActiveThinking(message) : ''
  const hasRunningBlocks = hasRunningProcessingBlocks(displayBlocks)
  const isAssistantSettled = isCancelled || message.status === 'done' || message.status === 'failed'
  const isAssistantRunning = !isAssistantSettled && (isStreaming || hasRunningBlocks)
  const canShowFinalArtifacts = !isAssistantRunning
  const processingStateKey = getMessageDisplayStateKey(conversationKey, message)
  const shouldShowThinking = shouldShowAssistantThinkingIndicator({
    isStreaming,
    hasProcessingDisplayBlock: hasProcessingDisplayBlock(displayBlocks),
    hasVisibleContent,
    hasTrailingCompletedProcessText: hasTrailingCompletedProcessText(displayBlocks),
  })
  const webSearchSources = isStreaming
    ? []
    : getWebSearchSourceItems(getWebSearchToolBlocks(displayBlocks))
  const memoryCitations = message.memoryCitations ?? []
  const generatedImages = useMemo(
    () => getGeneratedImages(displayBlocks, t('tool_activity.image_generation_alt')),
    [displayBlocks, t]
  )
  const [areHoverActionsVisible, setAreHoverActionsVisible] = useState(false)

  const openFileFromLink = onOpenWorkspaceFile
    ? (path: string, options?: WorkspaceFileOpenOptions) => {
        if (options) {
          onOpenWorkspaceFile(path, options)
          return
        }
        onOpenWorkspaceFile(path)
      }
    : undefined
  const references = getAssistantReferences(message.references, visibleContent, message.fileChanges)
  const lastProcessingBlock = displayBlocks.at(-1) ?? message.blocks?.at(-1)
  const processingStartedAt = runtimeTurn
    ? runtimeTurn.startedAt
    : getProcessingSummaryStartMs(message, message.blocks ?? [], false)
  const processingCompletedAt = runtimeTurn
    ? undefined
    : isAssistantRunning
      ? undefined
      : (getMessageTimestampMs(message.completedAt) ??
        lastProcessingBlock?.completedAt ??
        lastProcessingBlock?.createdAt)
  const processingDurationLabel =
    !isAssistantRunning && runtimeTurn && runtimeTurn.durationMs === undefined ? null : (
      <ProcessingDurationLabel
        startedAt={processingStartedAt}
        completedAt={processingCompletedAt}
        durationMs={isAssistantRunning ? undefined : runtimeTurn?.durationMs}
        isRunning={isAssistantRunning}
      />
    )

  return (
    <div className="min-w-0 max-w-full text-chat text-text-primary">
      <div
        className="w-full max-w-full"
        data-testid="message-hover-region"
        onPointerEnter={() => setAreHoverActionsVisible(true)}
        onPointerLeave={() => setAreHoverActionsVisible(false)}
      >
        <div className="w-full max-w-full">
          {shouldShowStoppedNotice ? (
            <div
              data-testid="assistant-stopped-notice"
              className="mb-3 w-full pb-1 text-xs text-text-muted"
            >
              {stoppedElapsedDuration
                ? t('assistant_status.stopped_after', {
                    duration: stoppedElapsedDuration,
                  })
                : t('assistant_status.stopped')}
            </div>
          ) : null}
          <AssistantTurnTimeline
            message={message}
            blocks={displayBlocks}
            content={visibleContent}
            stateKey={processingStateKey}
            isStreaming={isStreaming}
            isCancelled={isCancelled}
            isActiveTurn={isActiveTurn}
            hasProcessingActivity={Boolean(hasProcessingActivity)}
            durationLabel={processingDurationLabel}
            thinkingContent={activeThinkingContent}
            renderVisualization={renderVisualization}
            processingProps={{
              fileEditDurationsBySourceBlock,
              onOpenWorkspaceFile,
              onRequestUserInputSubmit,
              onRequestUserInputIgnore,
              onOpenAssistantPlan,
              onOpenSubagent,
              hideRequestUserInputBlocks,
              hiddenRequestUserInputIds,
            }}
          />
          {shouldShowThinking && !hasVisibleContent && (
            <AssistantThinkingIndicator content={activeThinkingContent} />
          )}
          {generatedImages.length > 0 ? (
            <GeneratedImageGallery services={imageServices} images={generatedImages} />
          ) : null}
          {canShowFinalArtifacts && hasVisibleContent && webSearchSources.length > 0 && (
            <WebSearchSourcesChip sources={webSearchSources} />
          )}
          {canShowFinalArtifacts && memoryCitations.length > 0 && (
            <CodexMemoryCitations citations={memoryCitations} onOpenFile={onOpenWorkspaceFile} />
          )}
          {canShowFinalArtifacts && references.length > 0 && openFileFromLink && (
            <CodexReferenceList references={references} onOpenFile={openFileFromLink} />
          )}
          {message.status === 'failed' && (
            <AssistantErrorCard
              error={message.error}
              errorType={message.errorType}
              rawError={hiddenErrorContent}
              message={message}
              onRetry={onRetryFailedMessage}
              onSwitchModel={onSwitchModelForFailedMessage}
            />
          )}
          {canShowFinalArtifacts &&
          message.fileChanges &&
          message.subtaskId &&
          onLoadFileChangesDiff &&
          onRevertFileChanges ? (
            <FileChangesCard
              subtaskId={message.subtaskId}
              summary={message.fileChanges}
              deviceOnline={devices.some(
                device =>
                  device.device_id === message.fileChanges?.device_id && device.status === 'online'
              )}
              onLoadDiff={onLoadFileChangesDiff}
              onRevert={onRevertFileChanges}
              onOpenReview={onOpenFileChangesReview}
              diffPreviewDisabled={
                fileChangesDiffPreviewDisabledSubtaskId === String(message.subtaskId)
              }
            />
          ) : null}
        </div>
        {message.status !== 'streaming' &&
          !isCancelled &&
          (hasVisibleContent || message.status === 'failed') && (
            <MessageHoverActions
              message={message}
              align="left"
              visible={areHoverActionsVisible}
              onFork={onFork}
            />
          )}
      </div>
    </div>
  )
}
