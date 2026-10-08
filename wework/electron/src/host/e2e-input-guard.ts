// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WebContents } from 'electron'
import { HostCapabilityError } from './capability-router.js'

/** Every synthetic input path is gated on an isolated verification controller. */
export function requireE2EControl(environment: NodeJS.ProcessEnv) {
  if (!environment.WEWORK_E2E_CONTROL_URL || environment.VITE_WEWORK_E2E !== 'true') {
    throw new HostCapabilityError('e2e_control_required', 'An isolated E2E controller is required')
  }
}

export function requireAvailableContents(contents: WebContents) {
  if (contents.isDestroyed()) {
    throw new HostCapabilityError('e2e_view_unavailable', 'Verification view is unavailable')
  }
}
