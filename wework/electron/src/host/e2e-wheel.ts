// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WebContents } from 'electron'
import { HostCapabilityError } from './capability-router.js'
import { requireAvailableContents, requireE2EControl } from './e2e-input-guard.js'

/** One wheel notch as Chromium delivers it from a physical mouse. */
const PIXELS_PER_WHEEL_TICK = 120
const MAX_STEPS = 600
const MAX_DURATION_MS = 30_000

export interface E2EWheelGestureOptions {
  x: number
  y: number
  /** Pixels per step; matches a wheel notch at the default {@link PIXELS_PER_WHEEL_TICK}. */
  deltaY: number
  steps: number
  intervalMs: number
}

function finiteNumber(value: unknown, label: string) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new HostCapabilityError('e2e_invalid_wheel_gesture', `${label} must be a finite number`)
  }
  return parsed
}

export function parseWheelGestureOptions(params: Record<string, unknown>): E2EWheelGestureOptions {
  const options: E2EWheelGestureOptions = {
    x: finiteNumber(params.x, 'x'),
    y: finiteNumber(params.y, 'y'),
    deltaY: finiteNumber(params.deltaY, 'deltaY'),
    steps: finiteNumber(params.steps, 'steps'),
    intervalMs: finiteNumber(params.intervalMs, 'intervalMs'),
  }
  if (options.x < 0 || options.y < 0) {
    throw new HostCapabilityError('e2e_invalid_wheel_gesture', 'wheel origin must not be negative')
  }
  if (options.deltaY === 0) {
    throw new HostCapabilityError('e2e_invalid_wheel_gesture', 'deltaY must not be zero')
  }
  if (!Number.isInteger(options.steps) || options.steps < 1 || options.steps > MAX_STEPS) {
    throw new HostCapabilityError(
      'e2e_invalid_wheel_gesture',
      `steps must be an integer between 1 and ${MAX_STEPS}`
    )
  }
  if (options.intervalMs < 0 || options.steps * options.intervalMs > MAX_DURATION_MS) {
    throw new HostCapabilityError(
      'e2e_invalid_wheel_gesture',
      `intervalMs must keep the gesture within ${MAX_DURATION_MS}ms`
    )
  }
  return options
}

/**
 * Delivers a real, time-distributed wheel gesture to the verification view.
 *
 * Synthetic `WheelEvent`s created in the renderer never scroll natively, which is
 * why the previous helpers had to assign `scrollTop` directly and could not
 * measure how the application actually behaves while scrolling. Chromium only
 * scrolls for input it considers trusted, so the gesture has to start here.
 */
export async function sendE2EWheelGesture(
  contents: WebContents,
  params: Record<string, unknown>,
  focusWindow: () => void | Promise<void>,
  environment: NodeJS.ProcessEnv = process.env
) {
  requireE2EControl(environment)
  const options = parseWheelGestureOptions(params)
  requireAvailableContents(contents)
  await focusWindow()
  contents.focus()

  const x = Math.round(options.x)
  const y = Math.round(options.y)
  const wheelTicksY =
    Math.trunc(options.deltaY / PIXELS_PER_WHEEL_TICK) || Math.sign(options.deltaY)
  const startedAt = Date.now()
  // The compositor scrolls whatever the input router believes the pointer is over,
  // and the DOM event is hit-tested separately from the event coordinates. A stale
  // position from an earlier click would scroll the wrong surface even though the
  // conversation receives the wheel events.
  contents.sendInputEvent({ type: 'mouseMove', x, y })
  for (let step = 0; step < options.steps; step += 1) {
    contents.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: options.deltaY,
      wheelTicksX: 0,
      wheelTicksY,
      // macOS trackpads deliver pixel deltas rather than wheel notches; the
      // conversation is built for that stream, and Chromium only applies the
      // default scroll for injected input on this path.
      hasPreciseScrollingDeltas: true,
      canScroll: true,
    })
    if (options.intervalMs > 0 && step + 1 < options.steps) {
      await new Promise(resolve => setTimeout(resolve, options.intervalMs))
    }
  }
  return {
    backend: 'electron-send-input-event',
    steps: options.steps,
    deltaY: options.deltaY,
    durationMs: Date.now() - startedAt,
  }
}
