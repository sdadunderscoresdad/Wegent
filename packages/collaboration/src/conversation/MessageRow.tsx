import { memo } from 'react'
import type {
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { AssistantMessage } from './AssistantTurn'
import type { MessageListProps } from './MessageList'
import { UserMessage } from './UserMessage'

type MessageRowProps = Pick<
  MessageListProps,
  | 'userMessageServices'
  | 'renderVisualization'
  | 'conversationKey'
  | 'devices'
  | 'onBeforeUserMessageToggle'
  | 'onRetryFailedMessage'
  | 'onSwitchModelForFailedMessage'
  | 'onLoadFileChangesDiff'
  | 'onRevertFileChanges'
  | 'onOpenFileChangesReview'
  | 'fileChangesDiffPreviewDisabledSubtaskId'
  | 'onOpenWorkspaceFile'
  | 'onOpenLocalSkillFile'
  | 'onRequestUserInputSubmit'
  | 'onRequestUserInputIgnore'
  | 'onOpenAssistantPlan'
  | 'onOpenSubagent'
  | 'onEditLastUserMessage'
  | 'onForkMessage'
  | 'hideRequestUserInputBlocks'
  | 'hiddenRequestUserInputIds'
> & {
  message: WorkbenchMessage
  runtimeTurn?: RuntimeConversationTurn
  isActiveTurn: boolean
  deferOffscreenRendering: boolean
  editable: boolean
  editing: boolean
  editSubmitting: boolean
  onEditingMessageChange: (messageId: string | null) => void
  devices: NonNullable<MessageListProps['devices']>
}

// Keep message-bound callbacks inside the row so unchanged history can skip rendering.
export const MessageRow = memo(function MessageRow({
  message,
  runtimeTurn,
  userMessageServices,
  renderVisualization,
  conversationKey,
  isActiveTurn,
  deferOffscreenRendering,
  devices,
  onBeforeUserMessageToggle,
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
  onForkMessage,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  editable,
  editing,
  editSubmitting,
  onEditingMessageChange,
}: MessageRowProps) {
  return (
    <article
      className={cn(
        'min-w-0',
        message.role === 'user' && 'flex justify-end',
        deferOffscreenRendering &&
          'data-[offscreen-ready=true]:[content-visibility:auto] focus-within:![content-visibility:visible]'
      )}
      data-defer-offscreen-rendering={deferOffscreenRendering || undefined}
      data-message-id={message.id}
      data-testid={`message-${message.role}`}
    >
      {message.role === 'user' ? (
        <UserMessage
          stateKey={conversationKey == null ? undefined : `${conversationKey}:${message.id}:user`}
          services={userMessageServices}
          message={message}
          onBeforeToggle={onBeforeUserMessageToggle}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onOpenLocalSkillFile={onOpenLocalSkillFile}
          editable={editable}
          editing={editing}
          editSubmitting={editSubmitting}
          onStartEdit={() => onEditingMessageChange(message.id)}
          onCancelEdit={() => onEditingMessageChange(null)}
          onSubmitEdit={content => onEditLastUserMessage?.(message, content)}
        />
      ) : (
        <AssistantMessage
          imageServices={userMessageServices.images}
          renderVisualization={
            renderVisualization ? part => renderVisualization(part, message) : undefined
          }
          message={message}
          runtimeTurn={runtimeTurn}
          conversationKey={conversationKey}
          isActiveTurn={isActiveTurn}
          devices={devices}
          onRetryFailedMessage={onRetryFailedMessage}
          onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
          onLoadFileChangesDiff={onLoadFileChangesDiff}
          onRevertFileChanges={onRevertFileChanges}
          onOpenFileChangesReview={onOpenFileChangesReview}
          fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onRequestUserInputSubmit={onRequestUserInputSubmit}
          onRequestUserInputIgnore={onRequestUserInputIgnore}
          onOpenAssistantPlan={onOpenAssistantPlan}
          onOpenSubagent={onOpenSubagent}
          hideRequestUserInputBlocks={hideRequestUserInputBlocks}
          hiddenRequestUserInputIds={hiddenRequestUserInputIds}
          onFork={onForkMessage && message.turnId ? () => onForkMessage(message) : undefined}
        />
      )}
    </article>
  )
})
