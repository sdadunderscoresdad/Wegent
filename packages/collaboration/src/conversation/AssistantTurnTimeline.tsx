import { useMemo, type ComponentProps, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ProcessingBlock, WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../markdown/AssistantMarkdown'
import { ToolBlocksDisplay } from './blocks/ProcessingSegment'
import {
  collapsePersistentProcessingExpansions,
  getProcessingDetailStateKey,
  useAnyPersistentProcessingExpansion,
  usePersistentProcessingExpansion,
} from './blocks/processingExpansionState'
import {
  getProcessingSummaryStartMs,
  hasRunningProcessingBlocks,
} from './assistantMessagePresentation'
import {
  projectAssistantTimeline,
  splitProcessingBlocks,
  type RuntimeDisplaySegment,
} from './assistantTimelineEntries'

type ProcessingProps = Pick<
  ComponentProps<typeof ToolBlocksDisplay>,
  | 'fileEditDurationsBySourceBlock'
  | 'onOpenWorkspaceFile'
  | 'onRequestUserInputSubmit'
  | 'onRequestUserInputIgnore'
  | 'onOpenAssistantPlan'
  | 'onOpenSubagent'
  | 'hideRequestUserInputBlocks'
  | 'hiddenRequestUserInputIds'
>

interface Props {
  message: WorkbenchMessage
  blocks: ProcessingBlock[]
  content: string
  stateKey: string
  isStreaming: boolean
  isCancelled: boolean
  isActiveTurn: boolean
  hasProcessingActivity: boolean
  durationLabel: ReactNode
  thinkingContent: string
  renderVisualization?: AssistantMarkdownProps['renderVisualization']
  processingProps: ProcessingProps
}

/** A turn has one persistent process region followed by keyed chronological entries. */
export function AssistantTurnTimeline({
  message,
  blocks,
  content,
  stateKey,
  isStreaming,
  isCancelled,
  isActiveTurn,
  hasProcessingActivity,
  durationLabel,
  thinkingContent,
  renderVisualization,
  processingProps,
}: Props) {
  const entries = projectAssistantTimeline(message.runtimeDisplayItems, blocks, content)
  const prefix = entries[0]?.kind === 'processing' ? entries[0] : null
  const body = prefix ? entries.slice(1) : entries
  const canCollapse =
    Boolean(prefix) &&
    !isCancelled &&
    !blocks.some(block => block.type === 'plan' && block.content.trim()) &&
    !hasRunningProcessingBlocks(blocks) &&
    !body.some(entry => entry.kind === 'processing') &&
    ((message.runtimeGuidanceSplitBefore && !isActiveTurn && !content.trim()) ||
      (content.trim() &&
        !message.runtimeGuidanceSplitBefore &&
        !message.runtimeGuidanceContinuation))
  // Only turn completion changes the default; explicit disclosure choices take
  // precedence in the shared store. Final text alone must not collapse a live turn.
  const defaultExpanded = message.status !== 'done' || isActiveTurn
  const [expanded, setExpanded] = usePersistentProcessingExpansion(
    `${stateKey}:final-processing`,
    defaultExpanded
  )
  const detailStateKeys = useMemo(
    () => blocks.map(block => getProcessingDetailStateKey(stateKey, block.id)),
    [blocks, stateKey]
  )
  const hasExpandedDetail = useAnyPersistentProcessingExpansion(detailStateKeys)
  const processingExpanded = expanded || hasExpandedDetail
  const toggleProcessing = () => {
    if (processingExpanded) {
      collapsePersistentProcessingExpansions(detailStateKeys)
      setExpanded(false)
    } else {
      setExpanded(true)
    }
  }

  const renderEntry = (entry: RuntimeDisplaySegment, trailing: boolean) => {
    if (entry.kind === 'content')
      return (
        <div key={entry.id} data-message-selectable-text data-testid="assistant-message-content">
          <AssistantMarkdown
            content={entry.content}
            isStreaming={isStreaming}
            onOpenFile={processingProps.onOpenWorkspaceFile}
            renderVisualization={renderVisualization}
          />
        </div>
      )
    const segments = splitProcessingBlocks(entry.blocks)
    return (
      <div key={entry.id}>
        {segments.map((segment, index) => (
          <ToolBlocksDisplay
            key={`${segment.kind}:${segment.blocks[0]?.id}`}
            {...processingProps}
            blocks={segment.blocks}
            isStreaming={isStreaming}
            startedAt={getProcessingSummaryStartMs(message, segment.blocks, isStreaming)}
            forceExpanded={segment.kind === 'narrative'}
            processingPhase={trailing && index === segments.length - 1 ? 'live' : 'intermediate'}
            showInterToolThinking={
              isStreaming &&
              trailing &&
              segment.kind === 'tool' &&
              !segments.slice(index + 1).some(candidate => candidate.kind === 'tool')
            }
            thinkingContent={thinkingContent}
            showSummary={segment.kind === 'tool'}
            stateKey={`${stateKey}:${segment.blocks[0]?.id ?? 'empty'}`}
            detailStateScopeKey={stateKey}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      <div data-testid={canCollapse ? 'final-processing-timeline' : undefined}>
        {hasProcessingActivity && !isCancelled && (
          <div
            className="mb-3 w-full border-b border-border pb-2 text-sm text-text-muted"
            data-testid={canCollapse ? undefined : 'live-processing-timeline'}
          >
            {canCollapse ? (
              <button
                type="button"
                data-testid="final-processing-toggle"
                aria-expanded={processingExpanded}
                className="flex min-h-8 items-center gap-1 text-sm text-text-muted hover:text-text-secondary"
                onClick={toggleProcessing}
              >
                {durationLabel}
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${processingExpanded ? '' : '-rotate-90'}`}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>
            ) : (
              <div className="flex min-h-8 items-center">{durationLabel}</div>
            )}
          </div>
        )}
        {prefix && (!canCollapse || processingExpanded)
          ? renderEntry(prefix, body.length === 0)
          : null}
      </div>
      {body.map((entry, index) => renderEntry(entry, index === body.length - 1))}
    </>
  )
}
