// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import {
  appHomesByRecency,
  buildMockTurn,
  conversationCandidates,
  findRolloutPath,
  heavyMarkdown,
  maxOrdinal,
  normalizeMessageCount,
  planMockHistory,
  parseArguments,
  resolveExecutorHome,
  restoreMockConversation,
  seedMockConversation,
  selectConversation,
} from './mock-long-conversation.mjs'

const cleanupPaths = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function temporaryExecutorHome() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-mock-conversation-'))
  cleanupPaths.push(directory)
  await mkdir(join(directory, 'runtime-work'), { recursive: true })
  return directory
}

async function writeIndexAt(path, index, modifiedMs) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(index)}\n`, 'utf8')
  const seconds = modifiedMs / 1000
  await utimes(path, seconds, seconds)
}

function rolloutFixture({ threadId, turnId, ordinal = 3 }) {
  const records = [
    { timestamp: '2026-09-13T13:00:00.000Z', ordinal: 1, type: 'session_meta', payload: {} },
    {
      timestamp: '2026-09-13T13:00:00.000Z',
      ordinal: 2,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnId, started_at: 1786945609 },
    },
    {
      timestamp: '2026-09-13T13:00:00.000Z',
      ordinal,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turnId,
        item: { id: 'real-user', type: 'message', role: 'user', content: [] },
      },
    },
  ]
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
}

async function seedFixture({ messageCount = 4 } = {}) {
  const executorHome = await temporaryExecutorHome()
  const threadId = '01a00e42-1ccd-7410-b34b-651fe792e6aa'
  const rolloutDirectory = join(executorHome, 'codex', 'sessions', '2026', '09', '13')
  await mkdir(rolloutDirectory, { recursive: true })
  const rolloutPath = join(rolloutDirectory, `rollout-2026-09-13T13-00-00-${threadId}.jsonl`)
  const originalRollout = rolloutFixture({
    threadId,
    turnId: '01a00e42-2023-72a2-8473-527fce8065a5',
  })
  await writeFile(rolloutPath, originalRollout, 'utf8')
  const index = {
    version: 1,
    tasks: {
      'codex-1': {
        local_task_id: 'codex-1',
        thread_id: threadId,
        workspace_path: '/tmp/workspace',
        title: '真实对话',
        runtime: 'codex',
        archived: false,
        updated_at: 100,
        recency_at: 100,
        runtime_handle: { lastTurnId: 'turn-old' },
      },
      'codex-2': {
        local_task_id: 'codex-2',
        thread_id: 'other-thread',
        runtime: 'claude',
        title: '其他运行时',
      },
    },
  }
  await writeFile(
    join(executorHome, 'runtime-work', 'index.json'),
    `${JSON.stringify(index)}\n`,
    'utf8'
  )
  return { executorHome, threadId, rolloutPath, originalRollout, index, messageCount }
}

describe('mock long conversation seeding', () => {
  test('normalizes requested message counts into user/assistant pairs', () => {
    expect(normalizeMessageCount(1000)).toBe(1000)
    expect(normalizeMessageCount(999)).toBe(1000)
    expect(normalizeMessageCount('7')).toBe(8)
    expect(() => normalizeMessageCount(1)).toThrow(/greater than or equal to 2/)
    expect(() => normalizeMessageCount(50000)).toThrow(/must not exceed/)
  })

  test('renders heavy markdown with a table and a code block', () => {
    const markdown = heavyMarkdown(7)
    expect(markdown).toContain('## 历史消息 7')
    expect(markdown).toContain('| 7-0 | value 0 | ok |')
    expect(markdown).toContain('export const row7_0 = compute(7 + 0)')
  })

  test('builds one turn with a start, paired messages, and a completion', () => {
    const records = buildMockTurn({
      threadId: 'thread-1',
      turnId: 'turn-1',
      messageCount: 4,
      startedAt: 1_700_000_000_000,
    })
    expect(records).toHaveLength(6)
    // The executor only reads `event_msg` envelopes; a bare task_started or
    // task_complete record leaves the turn stuck in the streaming state.
    expect(records[0].type).toBe('event_msg')
    expect(records[0].payload.type).toBe('task_started')
    expect(records.at(-1).type).toBe('event_msg')
    expect(records.at(-1).payload.type).toBe('task_complete')
    const items = records.slice(1, -1).map(record => record.payload.item)
    expect(items.map(item => item.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(items.every(item => item.type === 'message')).toBe(true)
    expect(records[1].payload.turn_id).toBe('turn-1')
  })

  test('continues rollout ordinals after the existing history', () => {
    const rolloutText = rolloutFixture({
      threadId: 'thread-1',
      turnId: 'turn-old',
      ordinal: 41,
    })
    expect(maxOrdinal(rolloutText)).toBe(41)
    const plan = planMockHistory({ rolloutText, threadId: 'thread-1', messageCount: 4 })
    expect(plan.messageCount).toBe(4)
    expect(plan.lines).toHaveLength(6)
    const ordinals = plan.lines.map(line => JSON.parse(line).ordinal)
    expect(ordinals).toEqual([42, 43, 44, 45, 46, 47])
    expect(plan.turnId).not.toBe('turn-old')
  })

  test('selects conversations by exact id, prefix, and rejects ambiguity', () => {
    const index = {
      tasks: {
        a: { local_task_id: 'codex-11', thread_id: 'thread-a', runtime: 'codex' },
        b: { local_task_id: 'codex-12', thread_id: 'thread-b', runtime: 'codex' },
      },
    }
    expect(selectConversation(index, 'codex-11').thread_id).toBe('thread-a')
    expect(selectConversation(index, 'thread-b').local_task_id).toBe('codex-12')
    expect(() => selectConversation(index, 'codex-1')).toThrow(/ambiguous/)
    expect(() => selectConversation(index, 'missing')).toThrow(/no conversation matches/)
  })

  test('lists only active codex conversations, newest first', () => {
    const index = {
      tasks: {
        old: {
          local_task_id: 'old',
          thread_id: 'thread-old',
          runtime: 'codex',
          title: '旧',
          recency_at: 10,
        },
        fresh: {
          local_task_id: 'fresh',
          thread_id: 'thread-fresh',
          runtime: 'codex',
          title: '新',
          recency_at: 20,
        },
        archived: {
          local_task_id: 'archived',
          thread_id: 'thread-archived',
          runtime: 'codex',
          archived: true,
          recency_at: 30,
        },
        claude: { local_task_id: 'claude', runtime: 'claude', recency_at: 40 },
      },
    }
    expect(conversationCandidates(index).map(item => item.localTaskId)).toEqual(['fresh', 'old'])
  })

  test('finds a rollout file nested under the codex sessions tree', async () => {
    const { executorHome, threadId, rolloutPath } = await seedFixture()
    await expect(findRolloutPath(join(executorHome, 'codex', 'sessions'), threadId)).resolves.toBe(
      rolloutPath
    )
    await expect(
      findRolloutPath(join(executorHome, 'codex', 'sessions'), 'missing-thread')
    ).resolves.toBeNull()
  })

  test('seeds a scrollable conversation and restores the original state', async () => {
    const { executorHome, threadId, rolloutPath, originalRollout } = await seedFixture()

    const seeded = await seedMockConversation({
      executorHome,
      selector: 'codex-1',
      messageCount: 6,
      now: 1_700_000_000_000,
    })
    expect(seeded.localTaskId).toBe('codex-1')
    expect(seeded.messageCount).toBe(6)

    const seededRollout = await readFile(rolloutPath, 'utf8')
    expect(seededRollout.startsWith(originalRollout)).toBe(true)
    expect(seededRollout).toContain('WEWORK_MOCK_LONG_CONVERSATION_QUESTION_2')

    const seededIndex = JSON.parse(
      await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
    )
    expect(seededIndex.tasks['codex-1'].title).toBe('Mock 长对话 · 6 条消息')
    expect(seededIndex.tasks['codex-1'].runtime_handle.cloudTranscript).toEqual({})
    expect(seededIndex.tasks['codex-1'].runtime_handle.completedTranscriptMessages).toBeUndefined()
    expect(seededIndex.tasks['codex-1'].thread_id).toBe(threadId)

    const restored = await restoreMockConversation({ executorHome, selector: 'codex-1' })
    expect(restored.localTaskId).toBe('codex-1')
    await expect(readFile(rolloutPath, 'utf8')).resolves.toBe(originalRollout)
    const restoredIndex = JSON.parse(
      await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
    )
    expect(restoredIndex.tasks['codex-1'].title).toBe('真实对话')
    expect(restoredIndex.tasks['codex-1'].runtime_handle.cloudTranscript).toBeUndefined()
  })

  test('refuses to seed twice unless forced', async () => {
    const { executorHome } = await seedFixture()
    await seedMockConversation({ executorHome, selector: 'codex-1', messageCount: 4 })
    await expect(
      seedMockConversation({ executorHome, selector: 'codex-1', messageCount: 4 })
    ).rejects.toThrow(/already has a mock backup/)
    await expect(
      seedMockConversation({ executorHome, selector: 'codex-1', messageCount: 4, force: true })
    ).resolves.toMatchObject({ localTaskId: 'codex-1' })
  })

  test('parses command line arguments', () => {
    expect(parseArguments(['--task', 'codex-1', '--count', '500'])).toMatchObject({
      selector: 'codex-1',
      messageCount: 500,
    })
    expect(parseArguments(['--list']).list).toBe(true)
    expect(parseArguments(['--help']).help).toBe(true)
    expect(parseArguments(['--app', 'io.wecode.wework.test']).appNamespace).toBe(
      'io.wecode.wework.test'
    )
    expect(() => parseArguments(['--count'])).toThrow(/requires a value/)
    expect(() => parseArguments(['--nope'])).toThrow(/unknown argument/)
  })
})

describe('executor home resolution', () => {
  async function appsHomeFixture() {
    const home = await mkdtemp(join(tmpdir(), 'wework-mock-apps-'))
    cleanupPaths.push(home)
    const appsDirectory = join(home, '.wework', 'apps')
    await writeIndexAt(
      join(appsDirectory, 'io.wecode.wework.test', 'runtime-work', 'index.json'),
      { tasks: {} },
      1_700_000_000_000
    )
    await writeIndexAt(
      join(appsDirectory, 'com.wegent.wework', 'runtime-work', 'index.json'),
      { tasks: {} },
      1_600_000_000_000
    )
    await mkdir(join(appsDirectory, 'without-index'), { recursive: true })
    return { home, appsDirectory }
  }

  test('ranks app homes by the recency of their runtime index', async () => {
    const { appsDirectory } = await appsHomeFixture()
    expect((await appHomesByRecency(appsDirectory)).map(home => home.namespace)).toEqual([
      'io.wecode.wework.test',
      'com.wegent.wework',
    ])
    await expect(appHomesByRecency(join(appsDirectory, 'missing'))).resolves.toEqual([])
  })

  test('defaults to the most recently used app home', async () => {
    const { home, appsDirectory } = await appsHomeFixture()
    await expect(resolveExecutorHome({ environment: { HOME: home } })).resolves.toEqual({
      executorHome: join(appsDirectory, 'io.wecode.wework.test'),
      source: 'app io.wecode.wework.test',
    })
  })

  test('honours an explicit app namespace and executor home', async () => {
    const { home, appsDirectory } = await appsHomeFixture()
    await expect(
      resolveExecutorHome({ environment: { HOME: home }, appNamespace: 'com.wegent.wework' })
    ).resolves.toEqual({
      executorHome: join(appsDirectory, 'com.wegent.wework'),
      source: 'app com.wegent.wework',
    })
    await expect(
      resolveExecutorHome({
        environment: { HOME: home, WEGENT_EXECUTOR_HOME: '/tmp/explicit-home' },
      })
    ).resolves.toEqual({ executorHome: '/tmp/explicit-home', source: 'WEGENT_EXECUTOR_HOME' })
  })

  test('falls back to the shared home when no app home exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wework-mock-empty-'))
    cleanupPaths.push(home)
    await expect(resolveExecutorHome({ environment: { HOME: home } })).resolves.toEqual({
      executorHome: join(home, '.wework'),
      source: 'shared home',
    })
  })
})
