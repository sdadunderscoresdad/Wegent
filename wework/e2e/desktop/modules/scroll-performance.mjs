// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

const VSYNC_MS = 1000 / 60

function round(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return null
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * ratio))
  return sortedValues[index]
}

/**
 * Turns raw animation-frame samples into the numbers a human would describe as
 * "smooth" or "stuttering": frame cadence, dropped frames, the longest moment the
 * content refused to move while the user was scrolling, and long main-thread tasks.
 */
export function summarizeScrollSample(sample, { vsyncMs = VSYNC_MS, gestureMs } = {}) {
  const frames = [...(sample?.frames ?? [])].sort((left, right) => left.time - right.time)
  const gaps = []
  for (let index = 1; index < frames.length; index += 1) {
    gaps.push(frames[index].time - frames[index - 1].time)
  }
  const sortedGaps = [...gaps].sort((left, right) => left - right)
  // Recognize faster displays without treating slow rendering as a slow monitor.
  const medianGap = percentile(sortedGaps, 0.5)
  const refreshMs = medianGap ? Math.min(vsyncMs, medianGap) : vsyncMs
  const droppedFrameCount = gaps.filter(gap => gap > refreshMs * 1.75).length
  const longTasks = sample?.longTasks ?? []

  // A stall is a run of consecutive frames in which the content did not move at
  // all while the gesture was still delivering input. Frames that each move the
  // content are smooth even when they are 16ms apart. Frames after the gesture
  // ended are the settle window and must not be counted as a freeze.
  const gestureFrames =
    typeof gestureMs === 'number' ? frames.filter(frame => frame.time <= gestureMs) : frames
  let longestScrollStallMs = 0
  let currentStallMs = 0
  for (let index = 1; index < gestureFrames.length; index += 1) {
    const gap = gestureFrames[index].time - gestureFrames[index - 1].time
    if (gestureFrames[index].scrollTop === gestureFrames[index - 1].scrollTop) {
      currentStallMs += gap
      longestScrollStallMs = Math.max(longestScrollStallMs, currentStallMs)
      continue
    }
    currentStallMs = 0
  }

  return {
    frameCount: frames.length,
    medianFrameGapMs: round(percentile(sortedGaps, 0.5)),
    p95FrameGapMs: round(percentile(sortedGaps, 0.95)),
    maxFrameGapMs: round(sortedGaps.at(-1) ?? null),
    droppedFrameCount,
    droppedFrameRatio: gaps.length ? round(droppedFrameCount / gaps.length, 3) : null,
    longestScrollStallMs: round(longestScrollStallMs),
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(longTasks.reduce((total, task) => total + (task.duration ?? 0), 0)),
    longestLongTaskMs: round(
      longTasks.reduce((longest, task) => Math.max(longest, task.duration ?? 0), 0)
    ),
    scrolledPx: frames.length ? Math.abs(frames.at(-1).scrollTop - frames[0].scrollTop) : 0,
    scrollTrace: frames.length
      ? {
          firstScrollTop: frames[0].scrollTop,
          lastScrollTop: frames.at(-1).scrollTop,
          minScrollTop: frames.reduce(
            (lowest, frame) => Math.min(lowest, frame.scrollTop),
            frames[0].scrollTop
          ),
          maxScrollTop: frames.reduce(
            (highest, frame) => Math.max(highest, frame.scrollTop),
            frames[0].scrollTop
          ),
        }
      : null,
  }
}

/**
 * Scrolls a real conversation while the renderer records animation frames, then
 * returns the summary.
 *
 * Each step dispatches the wheel intent a user gesture would (the conversation
 * only stops following the bottom for input it can see as a wheel event) and then
 * advances the viewport on the next animation frame, so the transcript pays the
 * same layout, paint and React cost it pays for a real scroll. Trusted wheel input
 * injected through the Electron host was measured first and does not scroll this
 * window while the E2E app runs in background mode.
 */
export async function measureScrollGesture(
  control,
  {
    scrollerSelector,
    direction = 'up',
    steps = 60,
    deltaY = 120,
    intervalMs = 16,
    settleMs = 600,
    timeoutMs = 30_000,
    probeNativeWheel = true,
  } = {}
) {
  const signedDelta = direction === 'down' ? Math.abs(deltaY) : -Math.abs(deltaY)
  // Record what trusted wheel input does on this machine. It is informational: a
  // background-mode E2E windows do not reliably perform native scrolling. The
  // comparison itself always uses the same frame-paced path below.
  let realWheelProbe = null
  if (probeNativeWheel)
    try {
      const probe = JSON.parse(
        await control.command('wheelGesture', scrollerSelector, {
          value: JSON.stringify({ deltaY: signedDelta, steps: 6, intervalMs: 8 }),
          timeoutMs,
        })
      )
      realWheelProbe = {
        movedPx: Math.round(Math.abs((probe.scrollAfter ?? 0) - (probe.scrollBefore ?? 0))),
        domWheelEvents: probe.domWheelEvents ?? null,
        origin: `${probe.originX ?? '?'},${probe.originY ?? '?'}`,
        originHit: probe.hitTestId ?? null,
      }
    } catch (error) {
      realWheelProbe = { error: error instanceof Error ? error.message : String(error) }
    }
  await control.command('startScrollPerformanceSampling', scrollerSelector, {
    // This is a watchdog, not a predicted gesture duration: a slow frame extends
    // scrollSteps, and the sampler must include the entire gesture.
    value: JSON.stringify({ durationMs: timeoutMs }),
    timeoutMs,
  })
  const gesture = JSON.parse(
    await control.command('scrollSteps', scrollerSelector, {
      value: JSON.stringify({ deltaY: signedDelta, steps, intervalMs }),
      timeoutMs,
    })
  )
  const sample = JSON.parse(
    await control.command('stopScrollPerformanceSampling', scrollerSelector)
  )
  assert.ok(
    sample.frames.at(-1)?.time >= gesture.endedAt - sample.startedAt - 100,
    'The sampler stopped before the gesture finished'
  )
  const gestureSample = {
    frames: sample.frames.filter(
      frame =>
        frame.time >= gesture.startedAt - sample.startedAt &&
        frame.time <= gesture.endedAt - sample.startedAt
    ),
    longTasks: sample.longTasks.filter(
      task => task.startTime >= gesture.startedAt && task.startTime < gesture.endedAt
    ),
  }
  await new Promise(resolve => setTimeout(resolve, settleMs))
  return {
    direction,
    steps,
    deltaY: signedDelta,
    gestureDurationMs: gesture.durationMs ?? null,
    gesture,
    realWheelProbe,
    ...summarizeScrollSample(gestureSample),
  }
}

/**
 * Tripwires only. Frame budgets are machine dependent, so the default assertions
 * check that the gesture really scrolled and that nothing froze; a numeric budget
 * is opt in through the environment once a team has baseline numbers.
 */
export function assertScrollHealth(metrics, { label = 'scroll', minScrolledPx = 200 } = {}) {
  assert.ok(
    metrics.frameCount > 0,
    `${label}: the renderer produced no animation frames during the gesture`
  )
  assert.ok(
    metrics.scrolledPx >= minScrolledPx,
    `${label}: the wheel gesture did not scroll the conversation ` +
      `(moved ${metrics.scrolledPx}px, expected at least ${minScrolledPx}px; ` +
      `origin hit ${metrics.gesture?.hitTestId ?? 'unknown'}, ` +
      `scrollHeight=${metrics.gesture?.scrollerScrollHeight ?? '?'}, ` +
      `clientHeight=${metrics.gesture?.scrollerHeight ?? '?'})`
  )
  assert.ok(
    (metrics.longestScrollStallMs ?? 0) < 2_000,
    `${label}: scrolling froze for ${metrics.longestScrollStallMs}ms`
  )
  const budget = Number(process.env.WEWORK_E2E_SCROLL_P95_BUDGET_MS)
  if (Number.isFinite(budget) && budget > 0) {
    assert.ok(
      metrics.p95FrameGapMs <= budget,
      `${label}: p95 frame gap ${metrics.p95FrameGapMs}ms exceeded the ${budget}ms budget`
    )
  }
}

export function describeScrollMetrics(metrics) {
  return (
    `${metrics.direction} frames=${metrics.frameCount} ` +
    `p95=${metrics.p95FrameGapMs}ms max=${metrics.maxFrameGapMs}ms ` +
    `dropped=${metrics.droppedFrameCount} (${metrics.droppedFrameRatio}) ` +
    `stall=${metrics.longestScrollStallMs}ms ` +
    `longTask=${metrics.longestLongTaskMs}ms/${metrics.longTaskTotalMs}ms ` +
    `moved=${metrics.scrolledPx}px ` +
    `realWheelMoved=${metrics.realWheelProbe?.movedPx ?? 'n/a'}px`
  )
}
