import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

/**
 * Temporary measurement harness for the conversation-timeline refactor.
 *
 * It seeds a long, content-heavy transcript directly into the Codex rollout of a
 * running local task, reopens it in the real Electron app, and records DOM,
 * heap, process memory, paging latency and main-thread frame gaps.
 *
 * It is intentionally not registered in the desktop checkpoint list: it reports
 * numbers instead of asserting a budget.
 */
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const SCROLLER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
const LOAD_OLDER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
const USER_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
const ASSISTANT_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const STREAM_CHUNK_COUNT = 40
const STREAM_CHUNK_DELAY_MS = 40
// A 1000-message history can delay the first visible update well past the
// shared 10s step timeout, so the probe waits longer on purpose.
const STREAM_WAIT_TIMEOUT_MS = 90_000

const SEED_PROMPT = 'WEWORK_E2E_PERF_HEAVY_SEED'
const SEED_COMPLETION = 'WEWORK_E2E_PERF_HEAVY_SEED_COMPLETE'
const STREAM_PROMPT = 'WEWORK_E2E_PERF_HEAVY_STREAM'
const STREAM_MARKER_PREFIX = 'WEWORK_E2E_PERF_HEAVY_STREAM_CHUNK'
const STREAM_COMPLETION = 'WEWORK_E2E_PERF_HEAVY_STREAM_COMPLETE'

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function assistantMessage(id, text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `${id}-message`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function heavyMarkdown(index) {
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

function rolloutRecord({ ordinal, threadId, turnId, item }) {
  return JSON.stringify({
    timestamp: '2026-09-13T13:23:16.000Z',
    ordinal,
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item },
  })
}

function buildHeavyHistory(rollout, threadId, messageCount) {
  const records = rollout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const turnId = records.findLast(
    record => record.type === 'event_msg' && record.payload?.type === 'task_started'
  )?.payload?.turn_id
  assert.ok(turnId, 'The perf-heavy rollout did not contain an active turn')
  const firstOrdinal = Math.max(0, ...records.map(record => Number(record.ordinal) || 0)) + 1
  const lines = []
  const pairs = Math.ceil(messageCount / 2)
  for (let index = 0; index < pairs; index += 1) {
    const ordinal = firstOrdinal + index * 2
    lines.push(
      rolloutRecord({
        ordinal,
        threadId,
        turnId,
        item: {
          id: `perf-heavy-user-${index}`,
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `PERF_HEAVY_QUESTION_${index} 请说明第 ${index} 步的结论。` }],
        },
      })
    )
    lines.push(
      rolloutRecord({
        ordinal: ordinal + 1,
        threadId,
        turnId,
        item: {
          id: `perf-heavy-assistant-${index}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: heavyMarkdown(index) }],
        },
      })
    )
  }
  return { turnId, lines }
}

async function findRolloutPath(directory, threadId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findRolloutPath(path, threadId)
      if (nested) return nested
    } else if (entry.name.endsWith(`${threadId}.jsonl`)) {
      return path
    }
  }
  return null
}

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const row = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the perf-heavy task row')
}

async function mountedMessages(control) {
  const user = Number(await control.command('getElementCount', USER_MESSAGE_SELECTOR))
  const assistant = Number(await control.command('getElementCount', ASSISTANT_MESSAGE_SELECTOR))
  return { user, assistant, total: user + assistant }
}

function webContentGroup(snapshot) {
  return snapshot.processMemory?.groups?.find(group => group.group === 'webkit-webcontent') ?? null
}

async function captureMetric(control, phase, extra = {}) {
  const snapshot = JSON.parse(
    await control.command('performanceSnapshot', 'body', { timeoutMs: 30_000 })
  )
  const group = webContentGroup(snapshot)
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    usedJSHeapSize: snapshot.rendererHeap?.usedSize ?? null,
    totalJSHeapSize: snapshot.rendererHeap?.totalSize ?? null,
    webContentRssKiB: group?.rss_kib ?? null,
    webContentFootprintKiB: group?.physical_footprint_kib ?? null,
    assistantContentElementCount: snapshot.assistantDom?.contentElementCount ?? null,
    assistantTextChars: snapshot.assistantDom?.textChars ?? null,
    runtimeConversationCache: snapshot.runtimeConversationCache ?? null,
    ...extra,
  }
}

async function sampleFrameGaps(control, durationMs, anchorText) {
  await control.command('startScrollStabilitySampling', USER_MESSAGE_SELECTOR, {
    value: JSON.stringify({
      scrollerSelector: SCROLLER_SELECTOR,
      anchorText,
      durationMs,
    }),
    timeoutMs: 30_000,
  })
  const deadline = Date.now() + durationMs + 5_000
  let sample = null
  while (Date.now() < deadline) {
    sample = JSON.parse(await control.command('getScrollStabilitySample', USER_MESSAGE_SELECTOR))
    if (sample.done) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const times = (sample?.frames ?? []).map(frame => frame.time).sort((left, right) => left - right)
  const gaps = times.slice(1).map((time, index) => time - times[index])
  const sortedGaps = [...gaps].sort((left, right) => left - right)
  return {
    frameSamples: times.length,
    missingFrames: sample?.missingFrames ?? null,
    scrollEvents: sample?.scrollEvents?.length ?? null,
    maxFrameGapMs: sortedGaps.length ? Math.round(sortedGaps.at(-1)) : null,
    p95FrameGapMs: sortedGaps.length
      ? Math.round(sortedGaps[Math.floor(sortedGaps.length * 0.95)])
      : null,
    medianFrameGapMs: sortedGaps.length
      ? Math.round(sortedGaps[Math.floor(sortedGaps.length / 2)])
      : null,
  }
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  let active = false
  let restartDesktopApp
  let streamRequestReceivedResolve
  const streamRequestReceived = new Promise(resolve => {
    streamRequestReceivedResolve = resolve
  })

  const messageCount = Number(process.env.WEWORK_E2E_PERF_MESSAGE_COUNT ?? 500)

  return {
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const responseId = `wework-perf-heavy-${Date.now()}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })

      if (body.includes(STREAM_PROMPT)) {
        response.flushHeaders()
        response.write(sse([responseCreated(responseId)]))
        streamRequestReceivedResolve()
        // Cumulative content keeps earlier chunks observable while the answer
        // grows, so the harness can time the first visible token.
        let accumulated = ''
        for (let index = 0; index < STREAM_CHUNK_COUNT; index += 1) {
          accumulated += `${STREAM_MARKER_PREFIX}_${index} 流式性能检测输出第 ${index} 段。\n\n`
          response.write(sse([assistantMessage(responseId, accumulated)]))
          await new Promise(resolve => setTimeout(resolve, STREAM_CHUNK_DELAY_MS))
        }
        response.end(
          sse([
            assistantMessage(responseId, `${accumulated}\n\n${STREAM_COMPLETION}`),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (body.includes(SEED_PROMPT)) {
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(responseId, SEED_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      response.end(sse([responseCreated(responseId), responseCompleted(responseId)]))
      return true
    },

    async verify(control) {
      active = true
      const report = {
        messageCount,
        startedAt: new Date().toISOString(),
        metrics: [],
        paging: [],
        notes: [],
        error: null,
      }
      const reportPath = join(resultDir, 'perf-heavy-conversation.json')
      const writeReport = async () => {
        await mkdir(resultDir, { recursive: true })
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      }

      try {
        assert.ok(restartDesktopApp, 'The perf-heavy scenario cannot restart Wework')
        await createSingleRootLocalProject(control, workspacePath, 'perf-heavy-conversation')
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
        await selectE2EModel(control)
        report.metrics.push(
          await captureMetric(control, 'empty-chat', { mounted: await mountedMessages(control) })
        )

        const knownRows = new Set(
          JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
            testId.startsWith('runtime-local-task-row-')
          )
        )
        await control.command('fill', COMPOSER_SELECTOR, { value: SEED_PROMPT })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', `${ASSISTANT_MESSAGE_SELECTOR}`, {
          text: SEED_COMPLETION,
          timeoutMs: uiTimeoutMs,
        })
        const taskRowTestId = await waitForNewTaskRow(control, knownRows, uiTimeoutMs)
        const taskId = taskRowTestId.replace('runtime-local-task-row-', '')
        const taskRow = `[data-testid="${taskRowTestId}"]`

        const seedStartedAt = Date.now()
        let seededMessages = null
        await restartDesktopApp(async () => {
          const indexPath = join(executorHome, 'runtime-work', 'index.json')
          const index = JSON.parse(await readFile(indexPath, 'utf8'))
          const task = Object.values(index.tasks ?? {}).find(
            candidate => candidate.local_task_id === taskId
          )
          assert.ok(task, 'The perf-heavy task was missing from the persisted runtime index')
          delete task.runtime_handle?.completedTranscriptMessages
          delete task.runtime_handle?.completedTranscriptThreadId
          const threadId = task.thread_id
          assert.equal(typeof threadId, 'string', 'The perf-heavy task has no Codex thread')
          const threadPath = await findRolloutPath(join(executorHome, 'codex', 'sessions'), threadId)
          assert.ok(threadPath, 'The perf-heavy Codex rollout was not found')
          const rollout = await readFile(threadPath, 'utf8')
          const heavy = buildHeavyHistory(rollout, threadId, messageCount)
          seededMessages = heavy.lines.length
          await appendFile(threadPath, `${heavy.lines.join('\n')}\n`, 'utf8')
          task.runtime_handle.cloudTranscript ??= {}
          await writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8')
        })
        await control.command('waitFor', taskRow, { timeoutMs: uiTimeoutMs })
        await control.command('clickWhenEnabled', taskRow, { timeoutMs: uiTimeoutMs })
        const openStartedAt = Date.now()
        await control.command('waitFor', `${ASSISTANT_MESSAGE_SELECTOR}`, {
          text: `历史消息 ${Math.ceil(messageCount / 2) - 1}`,
          timeoutMs: uiTimeoutMs,
        })
        report.open_initialPageMs = Date.now() - openStartedAt
        report.seedBuildMs = openStartedAt - seedStartedAt
        report.seededMessageRecords = seededMessages
        report.metrics.push(
          await captureMetric(control, 'initial-page', { mounted: await mountedMessages(control) })
        )
        await captureScreenshot(control, 'perf-heavy-01-initial-page.png', ACTIVE_WORKBENCH_SELECTOR)

        // Page backwards through the whole transcript with the product's own
        // "load older" control until no older page remains.
        const pagingDeadline = Date.now() + 10 * 60_000
        let previousTotal = 0
        while (Date.now() < pagingDeadline) {
          const hasOlder = Number(await control.command('getElementCount', LOAD_OLDER_SELECTOR)) > 0
          if (!hasOlder) break
          const before = await mountedMessages(control)
          const clickStartedAt = Date.now()
          await control.command('clickWhenEnabled', LOAD_OLDER_SELECTOR, {
            timeoutMs: uiTimeoutMs,
          })
          let after = before
          const settleDeadline = Date.now() + 60_000
          while (Date.now() < settleDeadline) {
            await new Promise(resolve => setTimeout(resolve, 100))
            const candidate = await mountedMessages(control)
            if (candidate.total > before.total) {
              after = candidate
              await new Promise(resolve => setTimeout(resolve, 400))
              after = await mountedMessages(control)
              if (after.total === candidate.total) break
            }
          }
          const durationMs = Date.now() - clickStartedAt
          report.paging.push({
            addedMessages: after.total - before.total,
            durationMs,
            mounted: after,
          })
          if (after.total <= previousTotal) {
            report.notes.push('Paging stalled: mounted message count did not grow')
            break
          }
          previousTotal = after.total
        }

        const fullMounted = await mountedMessages(control)
        report.metrics.push(
          await captureMetric(control, 'all-pages-loaded', { mounted: fullMounted })
        )
        await captureScreenshot(control, 'perf-heavy-02-all-pages.png', ACTIVE_WORKBENCH_SELECTOR)

        // Scroll interaction over the fully mounted history.
        await control.command('scrollToRatioAsUser', SCROLLER_SELECTOR, { value: '0' })
        report.scroll_atTop = await sampleFrameGaps(control, 2_500, 'PERF_HEAVY_QUESTION_0')
        await control.command('scrollToRatioAsUser', SCROLLER_SELECTOR, { value: '1' })
        report.scroll_atBottom = await sampleFrameGaps(
          control,
          2_500,
          `PERF_HEAVY_QUESTION_${Math.ceil(messageCount / 2) - 1}`
        )
        report.metrics.push(
          await captureMetric(control, 'after-scroll', { mounted: await mountedMessages(control) })
        )

        // Streaming a new answer while the whole heavy history stays mounted.
        const streamStartedAt = Date.now()
        await control.command('fill', COMPOSER_SELECTOR, { value: STREAM_PROMPT })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await Promise.race([
          streamRequestReceived,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('The perf-heavy streaming request was not received')),
              uiTimeoutMs
            )
          ),
        ])
        await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`, {
          text: `${STREAM_MARKER_PREFIX}_0`,
          timeoutMs: STREAM_WAIT_TIMEOUT_MS,
        })
        report.stream_firstTokenMs = Date.now() - streamStartedAt
        report.stream_frames = await sampleFrameGaps(control, 2_000, 'PERF_HEAVY_QUESTION_0')
        await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`, {
          text: STREAM_COMPLETION,
          timeoutMs: STREAM_WAIT_TIMEOUT_MS,
        })
        report.stream_totalMs = Date.now() - streamStartedAt
        report.metrics.push(
          await captureMetric(control, 'after-stream', { mounted: await mountedMessages(control) })
        )
        await captureScreenshot(control, 'perf-heavy-03-after-stream.png', ACTIVE_WORKBENCH_SELECTOR)

        // Idle settle to observe whether memory is released after streaming.
        await new Promise(resolve => setTimeout(resolve, 3_000))
        report.metrics.push(
          await captureMetric(control, 'settled', { mounted: await mountedMessages(control) })
        )
      } catch (error) {
        report.error = error instanceof Error ? error.stack ?? error.message : String(error)
        await writeReport()
        throw error
      }

      report.finishedAt = new Date().toISOString()
      await writeReport()
      console.log(
        `perf-heavy-conversation report: ${reportPath}\n${JSON.stringify(report, null, 2)}`
      )
    },
  }
}
