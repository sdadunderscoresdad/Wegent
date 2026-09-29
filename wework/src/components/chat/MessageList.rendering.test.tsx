import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type {
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import { createCollaborationTranslator } from '../../../../packages/collaboration/src/i18n'
import { ConversationTranslationProvider } from '../../../../packages/collaboration/src/conversation/ConversationTranslation'
import {
  MessageList,
  type MessageListProps,
} from '../../../../packages/collaboration/src/conversation/MessageList'
import { AssistantMessage } from '../../../../packages/collaboration/src/conversation/AssistantTurn'
import { UserMessage } from '../../../../packages/collaboration/src/conversation/UserMessage'

vi.mock('../../../../packages/collaboration/src/conversation/AssistantTurn', { spy: true })
vi.mock('../../../../packages/collaboration/src/conversation/UserMessage', { spy: true })

const translate = createCollaborationTranslator('en')
const userMessageServices = {
  images: {
    identity: (image: { id: number }) => String(image.id),
    load: vi.fn(),
    download: vi.fn(),
  },
}

function message(id: string, role: WorkbenchMessage['role']): WorkbenchMessage {
  return {
    id,
    role,
    turnId: id,
    content: id,
    status: 'done',
    createdAt: '2026-09-27T00:00:00Z',
  }
}

function conversation(props: Omit<MessageListProps, 'userMessageServices'>) {
  return (
    <ConversationTranslationProvider translate={translate}>
      <MessageList {...props} userMessageServices={userMessageServices} />
    </ConversationTranslationProvider>
  )
}

describe('message row rendering', () => {
  test('renders only the changed streaming row across a mounted conversation history', () => {
    const history = Array.from({ length: 40 }, (_, index) => [
      message(`user-${index}`, 'user'),
      message(`assistant-${index}`, 'assistant'),
    ]).flat()
    const latestUser = message('latest-user', 'user')
    const latestAssistant = {
      ...message('latest-assistant', 'assistant'),
      status: 'streaming' as const,
    }
    const onForkMessage = vi.fn()
    const onEditLastUserMessage = vi.fn()
    const renderVisualization = vi.fn(() => null)
    const props = {
      renderVisualization,
      onForkMessage,
      onEditLastUserMessage,
      canEditLastUserMessage: true,
      isWaitingForAssistant: true,
    }
    const { rerender } = render(
      conversation({ ...props, messages: [...history, latestUser, latestAssistant] })
    )
    vi.mocked(UserMessage).mockClear()
    vi.mocked(AssistantMessage).mockClear()

    for (let index = 1; index <= 3; index++) {
      rerender(
        conversation({
          ...props,
          messages: [
            ...history,
            latestUser,
            { ...latestAssistant, content: `Streaming update ${index}` },
          ],
        })
      )
    }

    expect({
      user: vi.mocked(UserMessage).mock.calls.length,
      assistant: vi.mocked(AssistantMessage).mock.calls.length,
    }).toEqual({ user: 0, assistant: 3 })
    expect(vi.mocked(AssistantMessage).mock.calls.map(([props]) => props.message.id)).toEqual([
      'latest-assistant',
      'latest-assistant',
      'latest-assistant',
    ])
  })

  test('preserves an edit draft across other row updates and submits through the current handler', async () => {
    const user = message('editable-user', 'user')
    const assistant = message('editable-assistant', 'assistant')
    const initialSave = vi.fn().mockResolvedValue(true)
    const props = { canEditLastUserMessage: true, onEditLastUserMessage: initialSave }
    const { rerender } = render(conversation({ ...props, messages: [user, assistant] }))
    fireEvent.click(screen.getByTestId('edit-message-button'))
    const editor = screen.getByTestId('edit-user-message-textarea') as HTMLElement & {
      value: string
    }
    act(() => {
      editor.value = 'Keep this draft'
    })
    vi.mocked(UserMessage).mockClear()
    vi.mocked(AssistantMessage).mockClear()

    const updatedAssistant = { ...assistant, content: 'Updated answer' }
    rerender(conversation({ ...props, messages: [user, updatedAssistant] }))

    expect(UserMessage).not.toHaveBeenCalled()
    expect(vi.mocked(AssistantMessage).mock.calls.map(([props]) => props.message.id)).toEqual([
      assistant.id,
    ])
    expect(screen.getByTestId('edit-user-message-textarea')).toBe(editor)
    expect(editor.value).toBe('Keep this draft')

    const latestUser = { ...user, content: 'Updated original prompt' }
    const latestSave = vi.fn().mockResolvedValue(true)
    rerender(
      conversation({
        ...props,
        messages: [latestUser, updatedAssistant],
        onEditLastUserMessage: latestSave,
      })
    )
    fireEvent.click(screen.getByTestId('submit-edit-user-message-button'))

    expect(initialSave).not.toHaveBeenCalled()
    expect(latestSave).toHaveBeenCalledWith(latestUser, 'Keep this draft')
    await waitFor(() =>
      expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()
    )
  })

  test('forks the current message and replaces its callback without retaining stale closures', async () => {
    const assistant = message('forked-assistant', 'assistant')
    const initialFork = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(conversation({ messages: [assistant], onForkMessage: initialFork }))
    const updatedAssistant = { ...assistant, content: 'Latest answer' }
    rerender(conversation({ messages: [updatedAssistant], onForkMessage: initialFork }))
    fireEvent.click(screen.getByTestId('fork-message-button'))
    expect(initialFork).toHaveBeenCalledWith(updatedAssistant)
    await waitFor(() => expect(screen.getByTestId('fork-message-button')).not.toBeDisabled())

    const latestFork = vi.fn().mockResolvedValue(undefined)
    rerender(conversation({ messages: [updatedAssistant], onForkMessage: latestFork }))
    fireEvent.click(screen.getByTestId('fork-message-button'))
    expect(latestFork).toHaveBeenCalledWith(updatedAssistant)
    expect(initialFork).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('fork-message-button')).not.toBeDisabled())
  })

  test('updates turn metadata for its final row while preserving unrelated message objects', () => {
    const history = message('history', 'assistant')
    const stopped = { ...message('stopped', 'assistant'), runtimeStatus: 'cancelled' as const }
    const messages = [history, stopped]
    const turn: RuntimeConversationTurn = {
      id: stopped.turnId!,
      status: 'cancelled',
      durationMs: 1000,
      items: [],
    }
    const { rerender } = render(conversation({ messages, turns: [turn] }))
    const previousNotice = screen.getByTestId('assistant-stopped-notice').textContent
    vi.mocked(AssistantMessage).mockClear()

    const updatedTurn = { ...turn, durationMs: 5000 }
    rerender(conversation({ messages, turns: [updatedTurn] }))

    expect(vi.mocked(AssistantMessage).mock.calls.map(([props]) => props.message.id)).toEqual([
      stopped.id,
    ])
    expect(vi.mocked(AssistantMessage).mock.calls[0][0].runtimeTurn).toBe(updatedTurn)
    expect(screen.getByTestId('assistant-stopped-notice').textContent).not.toBe(previousNotice)
  })

  test('updates the visualization renderer and its message argument for an existing row', () => {
    const assistant = {
      ...message('visualization', 'assistant'),
      content: '::codex-inline-vis{file="chart.html"}',
    }
    const initialRenderer = vi.fn(() => <div>Initial visualization</div>)
    const { rerender } = render(
      conversation({ messages: [assistant], renderVisualization: initialRenderer })
    )
    expect(screen.getByText('Initial visualization')).toBeInTheDocument()

    const latestAssistant = { ...assistant, content: `${assistant.content}\n\nUpdated answer` }
    const latestRenderer = vi.fn(() => <div>Latest visualization</div>)
    rerender(conversation({ messages: [latestAssistant], renderVisualization: latestRenderer }))

    expect(screen.queryByText('Initial visualization')).not.toBeInTheDocument()
    expect(screen.getByText('Latest visualization')).toBeInTheDocument()
    expect(latestRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'chart.html' }),
      latestAssistant
    )
  })
})
