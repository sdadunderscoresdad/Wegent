// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  assertScrollHealth,
  measureScrollGesture,
  summarizeScrollSample,
} from './scroll-performance.mjs'

const smoothThenStalled = {
  frames: [
    { time: 0, scrollTop: 1000 },
    { time: 16, scrollTop: 800 },
    { time: 32, scrollTop: 600 },
    { time: 100, scrollTop: 600 },
  ],
  longTasks: [
    { startTime: 40, duration: 120 },
    { startTime: 200, duration: 50 },
  ],
}

const smooth = {
  frames: [
    { time: 0, scrollTop: 1000 },
    { time: 16, scrollTop: 900 },
    { time: 32, scrollTop: 800 },
    { time: 48, scrollTop: 700 },
  ],
  longTasks: [],
}

describe('scroll performance summary', () => {
  test('reports frame cadence, dropped frames and the longest stall', () => {
    const metrics = summarizeScrollSample(smoothThenStalled)
    assert.equal(metrics.frameCount, 4)
    assert.equal(metrics.medianFrameGapMs, 16)
    assert.equal(metrics.p95FrameGapMs, 68)
    assert.equal(metrics.maxFrameGapMs, 68)
    assert.equal(metrics.droppedFrameCount, 1)
    assert.equal(metrics.droppedFrameRatio, 0.333)
    assert.equal(metrics.longestScrollStallMs, 68)
    assert.equal(metrics.scrolledPx, 400)
  })

  test('aggregates long tasks separately from frames', () => {
    const metrics = summarizeScrollSample(smoothThenStalled)
    assert.equal(metrics.longTaskCount, 2)
    assert.equal(metrics.longTaskTotalMs, 170)
    assert.equal(metrics.longestLongTaskMs, 120)
  })

  test('treats a steady 60Hz gesture as having no dropped frames', () => {
    const metrics = summarizeScrollSample(smooth)
    assert.equal(metrics.droppedFrameCount, 0)
    assert.equal(metrics.droppedFrameRatio, 0)
    assert.equal(metrics.longestScrollStallMs, 0)
    assert.equal(metrics.scrolledPx, 300)
  })

  test('ignores the settle window after the gesture ends', () => {
    const metrics = summarizeScrollSample(
      {
        frames: [
          { time: 0, scrollTop: 1000 },
          { time: 16, scrollTop: 900 },
          { time: 32, scrollTop: 800 },
          { time: 1_200, scrollTop: 800 },
        ],
      },
      { gestureMs: 40 }
    )
    assert.equal(metrics.longestScrollStallMs, 0)
  })

  test('returns empty metrics for a sample with no frames', () => {
    const metrics = summarizeScrollSample({})
    assert.deepEqual(metrics, {
      frameCount: 0,
      medianFrameGapMs: null,
      p95FrameGapMs: null,
      maxFrameGapMs: null,
      droppedFrameCount: 0,
      droppedFrameRatio: null,
      longestScrollStallMs: 0,
      longTaskCount: 0,
      longTaskTotalMs: 0,
      longestLongTaskMs: 0,
      scrolledPx: 0,
      scrollTrace: null,
    })
  })
})

describe('scroll health assertions', () => {
  test('samples a slow gesture to its actual end and excludes idle frames', async () => {
    const actions = []
    const control = {
      async command(action) {
        actions.push(action)
        if (action === 'wheelGesture') return '{}'
        if (action === 'startScrollPerformanceSampling') return ''
        if (action === 'scrollSteps')
          return JSON.stringify({ startedAt: 100, endedAt: 4100, durationMs: 4000 })
        if (action === 'stopScrollPerformanceSampling')
          return JSON.stringify({
            startedAt: 0,
            frames: [
              { time: 0, scrollTop: 1000 },
              { time: 100, scrollTop: 1000 },
              { time: 200, scrollTop: 800 },
              { time: 4100, scrollTop: 400 },
              { time: 4200, scrollTop: 400 },
            ],
            longTasks: [
              { startTime: 3000, duration: 500 },
              { startTime: 4150, duration: 100 },
            ],
          })
        throw new Error(`Unexpected command: ${action}`)
      },
    }
    const result = await measureScrollGesture(control, { steps: 2, intervalMs: 16, settleMs: 0 })
    assert.equal(result.frameCount, 3)
    assert.equal(result.gestureDurationMs, 4000)
    assert.equal(result.maxFrameGapMs, 3900)
    assert.equal(result.longTaskTotalMs, 500)
    assert.equal(result.scrolledPx, 600)
    assert.equal(actions.at(-1), 'stopScrollPerformanceSampling')
  })
  test('accepts a gesture that really scrolled the conversation', () => {
    assertScrollHealth(summarizeScrollSample(smooth), { label: 'unit' })
  })

  test('rejects a gesture that never moved the viewport', () => {
    assert.throws(
      () =>
        assertScrollHealth(
          summarizeScrollSample({
            frames: [
              { time: 0, scrollTop: 0 },
              { time: 16, scrollTop: 0 },
            ],
          }),
          { label: 'unit' }
        ),
      /did not scroll the conversation/
    )
  })

  test('rejects a freeze longer than two seconds', () => {
    assert.throws(
      () =>
        assertScrollHealth(
          summarizeScrollSample({
            frames: [
              { time: 0, scrollTop: 0 },
              { time: 16, scrollTop: 900 },
              { time: 2_600, scrollTop: 900 },
            ],
          }),
          { label: 'unit' }
        ),
      /froze for/
    )
  })
})
