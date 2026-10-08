#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Seeds a long, content-heavy transcript into an existing local Codex
 * conversation so a developer can scroll it by hand in the real Wework app.
 *
 * It appends one synthetic turn to the conversation's canonical Codex rollout
 * and marks the LocalTask as rollout-backed, which is the same path the
 * perf-heavy desktop scenario measures. Run it while Wework is closed: the
 * executor keeps the runtime index in memory and would otherwise overwrite it.
 *
 * Each Wework app namespaces its executor home under `~/.wework/apps/<appId>`,
 * so the script defaults to the app home that was used most recently instead of
 * the shared `~/.wework` home.
 */

export const DEFAULT_MESSAGE_COUNT = 1000
export const MAX_MESSAGE_COUNT = 20000

const BACKUP_DIRECTORY = 'mock-long-conversation'
const SEED_MARKER = 'WEWORK_MOCK_LONG_CONVERSATION'

export function weworkHome(environment = process.env) {
  return join(environment.HOME?.trim() || homedir(), '.wework')
}

export function appExecutorHome(environment, appNamespace) {
  return join(weworkHome(environment), 'apps', String(appNamespace).trim())
}

/**
 * Wework scopes its executor home per app under `~/.wework/apps/<appId>`, so the
 * shared `~/.wework` home belongs to no running app. Without an explicit target
 * the script follows the app home that wrote its runtime index most recently.
 */
export async function resolveExecutorHome({ environment = process.env, appNamespace } = {}) {
  const configured = environment.WEGENT_EXECUTOR_HOME?.trim()
  if (configured) return { executorHome: resolve(configured), source: 'WEGENT_EXECUTOR_HOME' }
  if (appNamespace?.trim()) {
    const namespace = appNamespace.trim()
    return { executorHome: appExecutorHome(environment, namespace), source: `app ${namespace}` }
  }
  const apps = await appHomesByRecency(join(weworkHome(environment), 'apps'))
  if (apps.length > 0) {
    return { executorHome: apps[0].executorHome, source: `app ${apps[0].namespace}` }
  }
  return { executorHome: weworkHome(environment), source: 'shared home' }
}

export async function appHomesByRecency(appsDirectory) {
  let entries = []
  try {
    entries = await readdir(appsDirectory, { withFileTypes: true })
  } catch {
    return []
  }
  const homes = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const executorHome = join(appsDirectory, entry.name)
    const indexPath = runtimeIndexPath(executorHome)
    if (!existsSync(indexPath)) continue
    const stats = await stat(indexPath)
    homes.push({ namespace: entry.name, executorHome, updatedAt: stats.mtimeMs })
  }
  return homes.sort((left, right) => right.updatedAt - left.updatedAt)
}

export function runtimeIndexPath(executorHome) {
  return join(executorHome, 'runtime-work', 'index.json')
}

function uuidV7(now = Date.now()) {
  const milliseconds = BigInt(now)
  const random = randomBytes(10)
  const hex = random.toString('hex')
  const timestamp = milliseconds.toString(16).padStart(12, '0')
  const variant = (0x8 | (random[0] & 0x3)).toString(16)
  return [
    timestamp.slice(0, 8),
    timestamp.slice(8, 12),
    `7${hex.slice(0, 3)}`,
    `${variant}${hex.slice(3, 6)}`,
    hex.slice(6, 18),
  ].join('-')
}

export function heavyMarkdown(index) {
  const sentence = `第 ${index} 段历史正文用于重消息性能检测，包含表格、代码块与多段说明文字。`
  return [
    `## 历史消息 ${index}`,
    '',
    sentence.repeat(3),
    '',
    `- 要点 A ${index}`,
    `- 要点 B ${index}`,
    '',
    '| 列 A | 列 B | 列 C |',
    '| --- | --- | --- |',
    ...Array.from({ length: 8 }, (_, row) => `| ${index}-${row} | value ${row} | ok |`),
    '',
    '```ts',
    ...Array.from(
      { length: 14 },
      (_, line) => `export const row${index}_${line} = compute(${index} + ${line})`
    ),
    '```',
  ].join('\n')
}

export function maxOrdinal(rolloutText) {
  let highest = 0
  for (const line of rolloutText.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = Number(JSON.parse(line).ordinal)
      if (Number.isFinite(value) && value > highest) highest = value
    } catch {
      continue
    }
  }
  return highest
}

export function buildMockTurn({ threadId, turnId, messageCount, startedAt = Date.now() }) {
  const pairs = Math.ceil(messageCount / 2)
  const startedAtSeconds = Math.floor(startedAt / 1000)
  const timestamp = new Date(startedAt).toISOString()
  const records = [
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
        started_at: startedAtSeconds,
        model_context_window: 249036,
        collaboration_mode_kind: 'default',
      },
    },
  ]
  for (let index = 0; index < pairs; index += 1) {
    records.push(
      mockItemRecord({
        timestamp,
        threadId,
        turnId,
        item: {
          id: `${SEED_MARKER}-user-${index}`,
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: mockQuestion(index) }],
        },
      })
    )
    records.push(
      mockItemRecord({
        timestamp,
        threadId,
        turnId,
        item: {
          id: `${SEED_MARKER}-assistant-${index}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: heavyMarkdown(index) }],
        },
      })
    )
  }
  const completedAt = Math.floor((startedAt + 1000) / 1000)
  records.push({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      completed_at: completedAt,
      duration_ms: 1000,
    },
  })
  return records
}

export function mockQuestion(index) {
  return `${SEED_MARKER}_QUESTION_${index} 请说明第 ${index} 步的结论。`
}

function mockItemRecord({ timestamp, threadId, turnId, item }) {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item },
  }
}

/** Returns the JSONL lines to append, with ordinals continuing after `firstOrdinal`. */
export function planMockHistory({ rolloutText, threadId, messageCount, now = Date.now() }) {
  const count = normalizeMessageCount(messageCount)
  const turnId = uuidV7(now)
  const firstOrdinal = maxOrdinal(rolloutText) + 1
  const records = buildMockTurn({ threadId, turnId, messageCount: count, startedAt: now })
  const lines = records.map((record, offset) =>
    JSON.stringify({ ...record, ordinal: firstOrdinal + offset })
  )
  return { turnId, lines, messageCount: count }
}

export function normalizeMessageCount(value) {
  const count = Number(value)
  if (!Number.isFinite(count) || count < 2) {
    throw new Error('message count must be a number greater than or equal to 2')
  }
  if (count > MAX_MESSAGE_COUNT) {
    throw new Error(`message count must not exceed ${MAX_MESSAGE_COUNT}`)
  }
  // Messages are always emitted as user/assistant pairs.
  return Math.ceil(count / 2) * 2
}

export function conversationCandidates(index, limit = 25) {
  return Object.values(index?.tasks ?? {})
    .filter(task => task && task.runtime === 'codex' && task.thread_id && !task.archived)
    .sort(
      (left, right) =>
        (right.recency_at ?? right.updated_at ?? 0) - (left.recency_at ?? left.updated_at ?? 0)
    )
    .slice(0, limit)
    .map(task => ({
      localTaskId: task.local_task_id,
      threadId: task.thread_id,
      title: task.title ?? '',
      workspacePath: task.workspace_path ?? '',
      updatedAt: task.recency_at ?? task.updated_at ?? null,
    }))
}

export function selectConversation(index, selector) {
  const query = String(selector ?? '').trim()
  if (!query) throw new Error('a conversation selector is required')
  const tasks = Object.values(index?.tasks ?? {}).filter(
    task => task && task.runtime === 'codex' && task.thread_id
  )
  const exact = tasks.find(task => task.local_task_id === query || task.thread_id === query)
  if (exact) return exact
  const matches = tasks.filter(
    task => task.local_task_id?.startsWith(query) || task.thread_id?.startsWith(query)
  )
  if (matches.length === 0) throw new Error(`no conversation matches "${query}"`)
  if (matches.length > 1) {
    const ids = matches.map(task => task.local_task_id).slice(0, 10)
    throw new Error(`conversation selector "${query}" is ambiguous: ${ids.join(', ')}`)
  }
  return matches[0]
}

export async function findRolloutPath(sessionsRoot, threadId) {
  const suffix = `${threadId}.jsonl`
  for (const entry of await readdir(resolve(sessionsRoot), { withFileTypes: true })) {
    const path = join(sessionsRoot, entry.name)
    if (entry.isDirectory()) {
      const nested = await findRolloutPath(path, threadId)
      if (nested) return nested
    } else if (entry.name.endsWith(suffix)) {
      return path
    }
  }
  return null
}

export function backupDirectory(executorHome, localTaskId) {
  return join(executorHome, 'runtime-work', BACKUP_DIRECTORY, localTaskId)
}

export async function readRuntimeIndex(executorHome) {
  const path = runtimeIndexPath(executorHome)
  if (!existsSync(path)) {
    throw new Error(`no runtime index at ${path}; pass --executor-home for a non-default install`)
  }
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function writeRuntimeIndex(executorHome, index) {
  await writeFile(runtimeIndexPath(executorHome), `${JSON.stringify(index)}\n`, 'utf8')
}

export async function seedMockConversation({
  executorHome,
  selector,
  messageCount = DEFAULT_MESSAGE_COUNT,
  title,
  now = Date.now(),
  dryRun = false,
  force = false,
}) {
  const index = await readRuntimeIndex(executorHome)
  const task = selectConversation(index, selector)
  const localTaskId = task.local_task_id
  const sessionsRoot = join(executorHome, 'codex', 'sessions')
  const rolloutPath = await findRolloutPath(sessionsRoot, task.thread_id)
  if (!rolloutPath) {
    throw new Error(`no Codex rollout found for thread ${task.thread_id} under ${sessionsRoot}`)
  }
  const directory = backupDirectory(executorHome, localTaskId)
  if (existsSync(join(directory, 'manifest.json')) && !force) {
    throw new Error(
      `conversation ${localTaskId} already has a mock backup at ${directory}; run --restore first or pass --force`
    )
  }
  const rolloutText = await readFile(rolloutPath, 'utf8')
  const plan = planMockHistory({ rolloutText, threadId: task.thread_id, messageCount, now })
  const nextTitle = title?.trim() || `Mock 长对话 · ${plan.messageCount} 条消息`
  if (dryRun) {
    return { localTaskId, title: nextTitle, rolloutPath, ...plan, dryRun: true }
  }

  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'rollout.jsonl'), rolloutText, 'utf8')
  await writeFile(join(directory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  await writeFile(
    join(directory, 'manifest.json'),
    `${JSON.stringify(
      {
        localTaskId,
        threadId: task.thread_id,
        rolloutPath,
        messageCount: plan.messageCount,
        turnId: plan.turnId,
        seededAt: new Date(now).toISOString(),
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const appended = rolloutText.endsWith('\n') ? rolloutText : `${rolloutText}\n`
  await writeFile(rolloutPath, `${appended}${plan.lines.join('\n')}\n`, 'utf8')

  task.title = nextTitle
  task.updated_at = now
  task.recency_at = now
  task.runtime_handle = { ...(task.runtime_handle ?? {}) }
  task.runtime_handle.cloudTranscript = task.runtime_handle.cloudTranscript ?? {}
  delete task.runtime_handle.completedTranscriptMessages
  delete task.runtime_handle.completedTranscriptThreadId
  await writeRuntimeIndex(executorHome, index)

  return {
    localTaskId,
    threadId: task.thread_id,
    title: nextTitle,
    rolloutPath,
    backupPath: directory,
    messageCount: plan.messageCount,
    turnId: plan.turnId,
  }
}

export async function restoreMockConversation({ executorHome, selector }) {
  const index = await readRuntimeIndex(executorHome)
  const task = selectConversation(index, selector)
  const localTaskId = task.local_task_id
  const directory = backupDirectory(executorHome, localTaskId)
  if (!existsSync(join(directory, 'manifest.json'))) {
    throw new Error(`conversation ${localTaskId} has no mock backup at ${directory}`)
  }
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const rolloutText = await readFile(join(directory, 'rollout.jsonl'), 'utf8')
  const originalTask = JSON.parse(await readFile(join(directory, 'task.json'), 'utf8'))
  await writeFile(manifest.rolloutPath, rolloutText, 'utf8')
  index.tasks[localTaskId] = originalTask
  await writeRuntimeIndex(executorHome, index)
  return { localTaskId, restoredRolloutPath: manifest.rolloutPath, backupPath: directory }
}

export function parseArguments(argv) {
  const options = { messageCount: DEFAULT_MESSAGE_COUNT }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(`${argument} requires a value`)
      return value
    }
    if (argument === '--list') options.list = true
    else if (argument === '--restore') options.restore = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--force') options.force = true
    else if (argument === '--task') options.selector = next()
    else if (argument === '--count') options.messageCount = normalizeMessageCount(next())
    else if (argument === '--title') options.title = next()
    else if (argument === '--executor-home') options.executorHome = resolve(next())
    else if (argument === '--app') options.appNamespace = next()
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

const HELP = `Seeds a long mock conversation into a local Wework conversation.

Usage:
  node scripts/mock-long-conversation.mjs --list
  node scripts/mock-long-conversation.mjs --task <localTaskId> [--count 1000] [--title "..."]
  node scripts/mock-long-conversation.mjs --task <localTaskId> --restore

Options:
  --task <id>            Conversation to seed (localTaskId or threadId, prefixes allowed)
  --count <n>            Synthetic messages to append (default ${DEFAULT_MESSAGE_COUNT}, max ${MAX_MESSAGE_COUNT})
  --title <text>         Title to give the mocked conversation
  --app <appId>          App to seed, for example io.wecode.wework.test
  --executor-home <path> Explicit executor home directory
  --list                 List candidate conversations
  --restore              Undo a previous seed for the conversation
  --dry-run              Report what would change without writing
  --force                Re-seed even if a backup already exists

Without --app or --executor-home the script targets the app home under
~/.wework/apps that most recently wrote its runtime index.

Quit Wework before seeding: the running executor would otherwise rewrite the runtime index.`

export async function runCli(argv, io = console) {
  const options = parseArguments(argv)
  if (options.help) {
    io.log(HELP)
    return
  }
  const resolved = options.executorHome
    ? { executorHome: options.executorHome, source: '--executor-home' }
    : await resolveExecutorHome({ appNamespace: options.appNamespace })
  const executorHome = resolved.executorHome
  io.log(`# executor home: ${executorHome} (${resolved.source})`)
  if (options.list) {
    const index = await readRuntimeIndex(executorHome)
    for (const candidate of conversationCandidates(index)) {
      io.log(`${candidate.localTaskId}\t${candidate.title}\t${candidate.workspacePath}`)
    }
    return
  }
  if (!options.selector) throw new Error('pass --task <localTaskId>, or --list to choose one')
  if (options.restore) {
    const result = await restoreMockConversation({
      executorHome,
      selector: options.selector,
    })
    io.log(`Restored ${result.localTaskId} from ${result.backupPath}`)
    return
  }
  const result = await seedMockConversation({
    executorHome,
    ...options,
    selector: options.selector,
  })
  if (result.dryRun) {
    io.log(`Dry run: would append ${result.messageCount} messages to ${result.localTaskId}`)
    return
  }
  io.log(
    [
      `Seeded ${result.messageCount} messages into ${result.localTaskId}.`,
      `Title: ${result.title}`,
      `Rollout: ${result.rolloutPath}`,
      `Backup: ${result.backupPath}`,
      '',
      'Open Wework, pick this conversation, and scroll. Undo with --restore.',
    ].join('\n')
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
