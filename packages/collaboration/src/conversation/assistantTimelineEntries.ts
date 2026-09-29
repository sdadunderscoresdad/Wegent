import type {
  ProcessingBlock,
  RuntimeAssistantDisplayItem,
} from '@wegent/chat-core/runtime-conversation'
import { isContextCompactionToolName, isGuidanceToolName } from './blocks/toolBlockKinds'
import { stripPluginWorkspaceResultMarkers } from '@wegent/chat-core/plugin-workspace-result'

type ProcessingSegment = {
  kind: 'tool' | 'narrative'
  blocks: ProcessingBlock[]
}

export type RuntimeDisplaySegment =
  | {
      kind: 'content'
      id: string
      content: string
    }
  | {
      kind: 'processing'
      id: string
      blocks: ProcessingBlock[]
    }

export function getOrderedRuntimeDisplaySegments(
  items: RuntimeAssistantDisplayItem[] | undefined,
  displayBlocks: ProcessingBlock[]
): RuntimeDisplaySegment[] {
  if (!items?.length) return []

  const blocksById = new Map(displayBlocks.map(block => [block.id, block]))
  const subagentsByAnchorId = new Map(
    displayBlocks.flatMap(block =>
      block.type === 'subagent' && block.anchorBlockId
        ? [[block.anchorBlockId, block] as const]
        : []
    )
  )
  const renderedAnchoredSubagentIds = new Set<string>()
  const segments: RuntimeDisplaySegment[] = []

  items.forEach(item => {
    if (item.type === 'assistant_text') {
      if (!item.content.trim()) return
      const previous = segments.at(-1)
      if (previous?.kind === 'content') {
        previous.content = `${previous.content}\n\n${item.content}`
      } else {
        segments.push({
          kind: 'content',
          id: `content:${item.id}`,
          content: item.content,
        })
      }
      return
    }

    const block = subagentsByAnchorId.get(item.id) ?? blocksById.get(item.id)
    if (!block) return
    if (block.type === 'subagent' && block.anchorBlockId) {
      if (renderedAnchoredSubagentIds.has(block.id)) return
      renderedAnchoredSubagentIds.add(block.id)
    }
    const previous = segments.at(-1)
    if (previous?.kind === 'processing') {
      previous.blocks.push(block)
    } else {
      segments.push({
        kind: 'processing',
        id: `processing:${block.id}`,
        blocks: [block],
      })
    }
  })

  return segments
}

export function splitProcessingBlocks(blocks: ProcessingBlock[]): ProcessingSegment[] {
  if (blocks.length === 0) return [{ kind: 'tool', blocks: [] }]

  const segments: ProcessingSegment[] = []

  blocks.forEach(block => {
    const kind = isCollapsibleToolBlock(block) ? 'tool' : 'narrative'
    const previous = segments.at(-1)
    if (previous?.kind === kind) {
      previous.blocks.push(block)
      return
    }
    segments.push({ kind, blocks: [block] })
  })

  return segments
}

export function isCollapsibleToolBlock(block: ProcessingBlock): boolean {
  if (block.type === 'file_changes') return true
  if (block.type !== 'tool') return false
  return !isGuidanceToolName(block.toolName) && !isContextCompactionToolName(block.toolName)
}

export function projectAssistantTimeline(
  items: RuntimeAssistantDisplayItem[] | undefined,
  blocks: ProcessingBlock[],
  content: string
): RuntimeDisplaySegment[] {
  const ordered = getOrderedRuntimeDisplaySegments(items, blocks)
  const orderedContent = ordered
    .flatMap(item => (item.kind === 'content' ? [item.content] : []))
    .join('\n\n')
  // Compare the same visible representation used by AssistantTurn. Streaming
  // chunks ending in whitespace or plugin markers must not change entry keys.
  if (items?.length && stripPluginWorkspaceResultMarkers(orderedContent) === content) {
    return ordered.map(entry =>
      entry.kind === 'content'
        ? {
            ...entry,
            content: stripPluginWorkspaceResultMarkers(entry.content),
          }
        : entry
    )
  }
  return [
    ...(blocks.length ? [{ kind: 'processing' as const, id: 'processing', blocks }] : []),
    ...(content.trim() ? [{ kind: 'content' as const, id: 'content', content }] : []),
  ]
}
