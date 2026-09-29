import assert from 'node:assert/strict'

/** Sample before opening the task so a top-to-bottom flash cannot pass a settled check. */
export async function verifyConversationInitialPosition({ control, scope, timeoutMs }) {
  const scroller = `${scope} [data-testid="desktop-workbench-content"]`
  const content = `${scope} [data-testid="desktop-chat-scroll-content"]`
  const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const taskId = debug.workbench.currentRuntimeTask?.taskId
  assert.ok(taskId, 'Initial-position fixture requires a persisted conversation')
  const taskRow = `[data-testid="runtime-local-task-row-${taskId}"]`

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', `${scope} [data-testid="chat-message-input"]`)
  // A fresh renderer has no viewport snapshot: first open must show the latest message.
  const readyCount = control.readyCount
  await control.command('reloadMainWindow', 'body')
  let timer
  try {
    await Promise.race([
      control.awaitReadyAfter(readyCount),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Initial-position reload did not reconnect')),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  await control.command('waitFor', taskRow, { timeoutMs })

  for (const mode of ['latest', 'reading']) {
    let expectedTop
    if (mode === 'reading') {
      expectedTop = Number(
        await control.command('scrollFromBottomAsUser', scroller, { value: '900' })
      )
      assert.ok(expectedTop > 0, 'Reading fixture needs history above the saved position')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', `${scope} [data-testid="chat-message-input"]`)
    }
    await control.command('startElementMetricsSampling', 'body', {
      target: `${scroller}, ${content}:has([data-message-id])`,
      value: '2000',
    })
    await control.command('clickWhenEnabled', taskRow, { timeoutMs })
    await control.command('waitFor', `${content} [data-testid="markdown-code-block"]`, {
      timeoutMs,
    })
    let sample
    const deadline = Date.now() + timeoutMs
    do {
      sample = JSON.parse(await control.command('getElementMetricsSample', 'body'))
      if (sample.done) break
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    assert.ok(sample.done, 'Initial-position frame sampling did not finish')
    const visibleFrames = sample.frames.filter(frame =>
      frame.elements.some(
        element =>
          element.testId === 'desktop-chat-scroll-content' &&
          element.visibility === 'visible' &&
          element.height > 0
      )
    )
    assert.ok(visibleFrames.length >= 5, `No visible ${mode} conversation frames captured`)
    for (const frame of visibleFrames) {
      const viewport = frame.elements.find(
        element => element.testId === 'desktop-workbench-content'
      )
      assert.ok(viewport, 'Visible conversation has no viewport')
      const target =
        mode === 'latest' ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : expectedTop
      assert.ok(
        Math.abs(viewport.scrollTop - target) <= 2,
        `${mode} conversation painted at ${viewport.scrollTop}, expected ${target} (frame ${frame.time}ms)`
      )
    }
    console.log(
      `[initial-position] ${mode}: ${visibleFrames.length} visible frames at the target position`
    )
  }
}
