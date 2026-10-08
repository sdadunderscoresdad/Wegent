// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WebContents } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import { parseWheelGestureOptions, sendE2EWheelGesture } from './e2e-wheel.js'

const environment = {
  WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
  VITE_WEWORK_E2E: 'true',
}

function fixture() {
  const view = {
    isDestroyed: () => false,
    focus: vi.fn(),
    sendInputEvent: vi.fn(),
  }
  return { view, contents: view as unknown as WebContents, focusWindow: vi.fn() }
}

const gesture = { x: 400, y: 300, deltaY: 120, steps: 3, intervalMs: 0 }

describe('isolated native wheel verification', () => {
  test('waits for window activation before sending native input', async () => {
    const { view, contents } = fixture()
    let activate!: () => void
    const activated = new Promise<void>(resolve => {
      activate = resolve
    })
    const input = sendE2EWheelGesture(contents, gesture, () => activated, environment)
    expect(view.sendInputEvent).not.toHaveBeenCalled()
    activate()
    await input
    expect(view.sendInputEvent).toHaveBeenCalledTimes(4)
  })

  test('sends one trusted wheel notch per step', async () => {
    const { view, contents, focusWindow } = fixture()
    const result = await sendE2EWheelGesture(contents, gesture, focusWindow, environment)
    expect(view.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'mouseMove', x: 400, y: 300 },
      ...Array.from({ length: 3 }, () => ({
        type: 'mouseWheel',
        x: 400,
        y: 300,
        deltaX: 0,
        deltaY: 120,
        wheelTicksX: 0,
        wheelTicksY: 1,
        hasPreciseScrollingDeltas: true,
        canScroll: true,
      })),
    ])
    expect(result).toMatchObject({
      backend: 'electron-send-input-event',
      steps: 3,
      deltaY: 120,
    })
  })

  test('spaces steps by the requested interval', async () => {
    const { contents, focusWindow } = fixture()
    const startedAt = Date.now()
    await sendE2EWheelGesture(
      contents,
      { ...gesture, steps: 3, intervalMs: 4 },
      focusWindow,
      environment
    )
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(8)
  })

  test('rejects scrolling upward and downward in the same gesture shape', () => {
    expect(
      parseWheelGestureOptions({ ...gesture, deltaY: -120, wheelTicksY: undefined })
    ).toMatchObject({ deltaY: -120 })
  })

  test('rejects a gesture that is not bound to an isolated controller', async () => {
    const { contents, focusWindow } = fixture()
    await expect(
      sendE2EWheelGesture(contents, gesture, focusWindow, { VITE_WEWORK_E2E: 'true' })
    ).rejects.toThrow(/isolated E2E controller/)
  })

  test('rejects invalid gesture parameters', () => {
    expect(() => parseWheelGestureOptions({ ...gesture, steps: 0 })).toThrow(/steps/)
    expect(() => parseWheelGestureOptions({ ...gesture, deltaY: 0 })).toThrow(/deltaY/)
    expect(() => parseWheelGestureOptions({ ...gesture, x: -1 })).toThrow(/negative/)
    expect(() => parseWheelGestureOptions({ ...gesture, y: Number.NaN })).toThrow(/finite/)
  })
})
