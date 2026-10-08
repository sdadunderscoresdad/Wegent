import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import {
  getSingleElementMetrics,
  waitForElementInsideScroller,
} from '../modules/conversation-layout.mjs'
import {
  assertScrollHealth,
  describeScrollMetrics,
  measureScrollGesture,
} from '../modules/scroll-performance.mjs'

/**
 * Conversation scroll-performance regression.
 *
 * It seeds a long, content-heavy transcript directly into the Codex rollout of a
 * running local task, reopens it in the real Electron app, scrolls it with
 * frame-paced input, and records DOM, heap, process memory, paging latency and frame
 * gaps. The scroll numbers are asserted as a ratio between the transcript the app
 * loads by itself and the fully mounted history, which cancels out machine speed.
 */
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
// The timeline scroller moved between the workbench pane and the chat pane across
// revisions, so the scenario resolves whichever one the running app exposes.
const SCROLLER_CANDIDATES = [
  `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
  `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`,
]
const LOAD_OLDER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
const USER_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
const ASSISTANT_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const STREAM_CHUNK_COUNT = 40
const STREAM_CHUNK_DELAY_MS = 40
// A 1000-message history can delay the first visible update well past the
// shared 10s step timeout, so the probe waits longer on purpose.
const STREAM_WAIT_TIMEOUT_MS = 90_000
// A real wheel gesture: 60 notches at ~60Hz is roughly one second of continuous
// user scrolling, long enough for jank to show up in the frame samples.
const SCROLL_GESTURE = { steps: 60, deltaY: 120, intervalMs: 16, settleMs: 700, timeoutMs: 60_000 }

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

function heavyMarkdown(index, weight = 1) {
  const sentence = `第 ${index} 段历史正文用于重消息性能检测，包含表格、代码块与多段说明文字。`
  const sections = Array.from({ length: Math.max(1, weight) }, (_, section) =>
    [
      `### 片段 ${section} · 历史消息 ${index}`,
      '',
      // Weight scales paragraphs; report both character count and UTF-8 bytes.
      sentence.repeat(30),
      '',
      `- 要点 A ${index}-${section}`,
      `- 要点 B ${index}-${section}`,
    ].join('\n')
  )
  return [
    `## 历史消息 ${index}`,
    '',
    ...sections,
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

function buildHeavyHistory(rollout, threadId, messageCount, messageWeight) {
  const records = rollout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const firstOrdinal = Math.max(0, ...records.map(record => Number(record.ordinal) || 0)) + 1
  const lines = []
  const pairs = Math.ceil(messageCount / 2)
  let ordinal = firstOrdinal
  // One turn per exchange keeps the transcript shape a real conversation has and
  // lets the product's "load older" pagination page it 40 turns at a time.
  for (let index = 0; index < pairs; index += 1) {
    const turnId = `perf-heavy-turn-${index}`
    lines.push(
      JSON.stringify({
        timestamp: '2026-09-13T13:23:16.000Z',
        ordinal: ordinal++,
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: turnId,
          started_at: 1786945609,
          model_context_window: 249036,
          collaboration_mode_kind: 'default',
        },
      })
    )
    lines.push(
      rolloutRecord({
        ordinal,
        threadId,
        turnId,
        item: {
          id: `perf-heavy-user-${index}`,
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `PERF_HEAVY_QUESTION_${index} 请说明第 ${index} 步的结论。`,
            },
          ],
        },
      })
    )
    ordinal += 1
    lines.push(
      rolloutRecord({
        ordinal,
        threadId,
        turnId,
        item: {
          id: `perf-heavy-assistant-${index}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: heavyMarkdown(index, messageWeight) }],
        },
      })
    )
    ordinal += 1
    lines.push(
      JSON.stringify({
        timestamp: '2026-09-13T13:23:16.000Z',
        ordinal: ordinal++,
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: turnId,
          completed_at: 1786945610,
          duration_ms: 1000,
        },
      })
    )
  }
  return { lines, turnCount: pairs }
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

function recordScrollMeasurement(report, phase, metrics) {
  report.scroll.measurements.push({ phase, ...metrics })
  report.notes.push(`scroll ${phase}: ${describeScrollMetrics(metrics)}`)
}

async function resolveScrollerSelector(control) {
  for (const candidate of SCROLLER_CANDIDATES) {
    const count = Number(await control.command('getElementCount', candidate))
    if (count > 0) return candidate
  }
  throw new Error(`No conversation scroller found among ${SCROLLER_CANDIDATES.join(', ')}`)
}

function latestScrollMeasurement(report) {
  return report.scroll.measurements.at(-1)
}

/**
 * Frame budgets are machine dependent, so this compares the same gesture over the
 * initial page and the fully loaded history inside a single run: the ratio cancels
 * out how fast the machine is, while still catching "scrolling degrades with size".
 *
 * The ratio is a regression tripwire calibrated against today's measurements
 * (500 light messages already reach ~6.5x), not a performance target. Tighten it
 * as scrolling improves; the raw numbers stay in the report either way.
 */
function assertScrollScaling(report, { maxP95Ratio = 10, absoluteP95Ms = 48 } = {}) {
  const baseline = report.scroll.measurements.find(item => item.phase === 'initial-page-up')
  const heavy = report.scroll.measurements.find(item => item.phase === 'fully-loaded-up')
  if (!baseline?.p95FrameGapMs || !heavy?.p95FrameGapMs) return
  const p95Ratio = Math.round((heavy.p95FrameGapMs / baseline.p95FrameGapMs) * 100) / 100
  report.scroll.comparison = {
    baselineP95FrameGapMs: baseline.p95FrameGapMs,
    heavyP95FrameGapMs: heavy.p95FrameGapMs,
    p95Ratio,
  }
  assert.ok(
    heavy.p95FrameGapMs <= absoluteP95Ms || p95Ratio <= maxP95Ratio,
    `Scrolling the fully loaded history is ${p95Ratio}x the initial page ` +
      `(p95 ${heavy.p95FrameGapMs}ms vs ${baseline.p95FrameGapMs}ms)`
  )
}

function webContentGroup(snapshot) {
  return snapshot.processMemory?.groups?.find(group => group.group === 'webkit-webcontent') ?? null
}

async function verifyHistoryNavigation(control, scrollerSelector, messageCount) {
  const results = []
  for (const index of [0, Math.floor(messageCount / 4), Math.ceil(messageCount / 2) - 1]) {
    const text = `PERF_HEAVY_QUESTION_${index} `
    const turnIndex = await control.command(
      'getAttribute',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"]`,
      { text, value: 'data-turn-index' }
    )
    const messageId = await control.command('getAttribute', USER_MESSAGE_SELECTOR, {
      text,
      value: 'data-message-id',
    })
    const target = `${USER_MESSAGE_SELECTOR}[data-message-id="${messageId}"]`
    const marker = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"][data-turn-index="${turnIndex}"]`
    assert.equal(
      Number(await control.command('getElementCount', marker)),
      1,
      'History navigation must expose one marker for the requested turn'
    )
    await control.command('click', marker)
    const { element } = await waitForElementInsideScroller(
      control,
      target,
      scrollerSelector,
      `History navigation ${index} did not reveal the requested prompt`,
      10_000
    )
    await new Promise(resolve => setTimeout(resolve, 500))
    const settled = await getSingleElementMetrics(control, target, 'History anchor after layout')
    const driftPx = Math.abs(settled.top - element.top)
    assert.ok(driftPx <= 2, `History navigation ${index} drifted ${driftPx}px after layout`)
    results.push({ index, driftPx })
  }
  return results
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
  const messageWeight = Number(process.env.WEWORK_E2E_PERF_MESSAGE_WEIGHT ?? 1)

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
        messageWeight,
        assistantMessageChars: heavyMarkdown(Math.floor(messageCount / 4), messageWeight).length,
        assistantMessageBytes: Buffer.byteLength(
          heavyMarkdown(Math.floor(messageCount / 4), messageWeight)
        ),
        startedAt: new Date().toISOString(),
        metrics: [],
        paging: [],
        scroll: { measurements: [], comparison: null },
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
          const threadPath = await findRolloutPath(
            join(executorHome, 'codex', 'sessions'),
            threadId
          )
          assert.ok(threadPath, 'The perf-heavy Codex rollout was not found')
          const rollout = await readFile(threadPath, 'utf8')
          const heavy = buildHeavyHistory(rollout, threadId, messageCount, messageWeight)
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
        report.seededRolloutRecords = seededMessages
        const scrollerSelector = await resolveScrollerSelector(control)
        report.metrics.push(
          await captureMetric(control, 'initial-page', { mounted: await mountedMessages(control) })
        )
        await captureScreenshot(
          control,
          'perf-heavy-01-initial-page.png',
          ACTIVE_WORKBENCH_SELECTOR
        )

        // The background window uses frame-paced scrolling. Trusted native wheel
        // delivery is probed separately and is not claimed as the measured path.
        await control.command('scrollToBottomAsUser', scrollerSelector)
        recordScrollMeasurement(
          report,
          'initial-page-up',
          await measureScrollGesture(control, {
            scrollerSelector: scrollerSelector,
            direction: 'up',
            ...SCROLL_GESTURE,
          })
        )
        assertScrollHealth(latestScrollMeasurement(report), { label: 'initial-page scroll' })

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
        assert.equal(
          Number(await control.command('getElementCount', LOAD_OLDER_SELECTOR)),
          0,
          'The performance sample must include every history page'
        )
        assert.equal(
          fullMounted.total,
          Math.ceil(messageCount / 2) * 2 + 2,
          'The performance sample did not mount the complete seeded history'
        )
        report.metrics.push(
          await captureMetric(control, 'all-pages-loaded', { mounted: fullMounted })
        )
        await captureScreenshot(control, 'perf-heavy-02-all-pages.png', ACTIVE_WORKBENCH_SELECTOR)

        // The same gesture over the fully mounted history: the difference between
        // these two measurements is what "500 messages stutter" actually means.
        await control.command('scrollToBottomAsUser', scrollerSelector)
        recordScrollMeasurement(
          report,
          'fully-loaded-up',
          await measureScrollGesture(control, {
            scrollerSelector: scrollerSelector,
            direction: 'up',
            ...SCROLL_GESTURE,
          })
        )
        assertScrollHealth(latestScrollMeasurement(report), { label: 'fully-loaded scroll' })
        recordScrollMeasurement(
          report,
          'fully-loaded-down',
          await measureScrollGesture(control, {
            scrollerSelector: scrollerSelector,
            direction: 'down',
            ...SCROLL_GESTURE,
          })
        )
        assertScrollHealth(latestScrollMeasurement(report), { label: 'fully-loaded scroll down' })
        assertScrollScaling(report)
        report.metrics.push(
          await captureMetric(control, 'after-scroll', { mounted: await mountedMessages(control) })
        )
        report.navigation = await verifyHistoryNavigation(control, scrollerSelector, messageCount)
        await control.command('scrollToRatioAsUser', scrollerSelector, { value: '0.5' })
        report.fastScroll = []
        for (const direction of ['up', 'down']) {
          const metrics = await measureScrollGesture(control, {
            scrollerSelector,
            direction,
            steps: 20,
            probeNativeWheel: false,
            deltaY: 1200,
            intervalMs: 0,
            settleMs: 500,
            timeoutMs: 60_000,
          })
          assertScrollHealth(metrics, { label: `Fast ${direction} scroll` })
          const actualMovement = metrics.gesture.scrollAfter - metrics.gesture.scrollBefore
          const expectedMovement = metrics.gesture.deltaY * metrics.gesture.steps
          assert.ok(
            Math.abs(actualMovement - expectedMovement) <= 2,
            `Fast ${direction} scrolling changed its reading position by ${actualMovement - expectedMovement}px`
          )
          report.fastScroll.push(metrics)
        }

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
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: `${STREAM_MARKER_PREFIX}_0`,
            timeoutMs: STREAM_WAIT_TIMEOUT_MS,
          }
        )
        report.stream_firstTokenMs = Date.now() - streamStartedAt
        report.stream_frames = await measureScrollGesture(control, {
          scrollerSelector: scrollerSelector,
          direction: 'up',
          steps: 40,
          deltaY: 120,
          intervalMs: 16,
          settleMs: 400,
        })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: STREAM_COMPLETION,
            timeoutMs: STREAM_WAIT_TIMEOUT_MS,
          }
        )
        report.stream_totalMs = Date.now() - streamStartedAt
        report.metrics.push(
          await captureMetric(control, 'after-stream', { mounted: await mountedMessages(control) })
        )
        await captureScreenshot(
          control,
          'perf-heavy-03-after-stream.png',
          ACTIVE_WORKBENCH_SELECTOR
        )

        // Idle settle to observe whether memory is released after streaming.
        await new Promise(resolve => setTimeout(resolve, 3_000))
        report.metrics.push(
          await captureMetric(control, 'settled', { mounted: await mountedMessages(control) })
        )
      } catch (error) {
        report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
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
