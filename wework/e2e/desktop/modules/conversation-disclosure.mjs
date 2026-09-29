import assert from 'node:assert/strict'

/** PR #3697: opening a detail cannot replay its height on subsequent reader input. */
export async function verifyToolDetailDisclosure({ control, scope, timeoutMs }) {
  const scroller = `${scope} [data-testid="desktop-workbench-content"]`
  const toggles = `${scope} [data-tool-detail-toggle]`
  const anchorId = 'streaming-text-tool-detail-row'
  const anchor = `${scope} [data-e2e-anchor-id="${anchorId}"]`
  const output = `${scope} [data-testid="shell-tool-output"]`
  const metrics = async selector => {
    const elements = JSON.parse(await control.command('getElementMetrics', selector))
    assert.equal(elements.length, 1, `Expected one disclosure target: ${selector}`)
    return elements[0]
  }
  const fromBottom = element =>
    Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)

  await control.command('waitFor', toggles, { timeoutMs })
  // Start alignment leaves upward scroll range even when this is the first turn.
  await control.command('scrollIntoViewAsUser', toggles, { text: '运行', value: 'start' })
  await control.command('markElementWithText', toggles, { text: '运行', value: anchorId })
  await control.command('waitFor', anchor, { visible: true, timeoutMs })
  const before = await metrics(anchor)
  await control.command('click', anchor)
  await control.command('waitFor', output, { stableMs: 400, timeoutMs })
  const after = await metrics(anchor)
  assert.ok(
    Math.abs(after.top - before.top) <= 8,
    `Opening the tool detail moved its row by ${after.top - before.top}px instead of keeping the reader in place`
  )
  const openedViewport = await metrics(scroller)
  assert.ok(
    openedViewport.scrollTop >= 12,
    `The reader needs at least 12px of upward scroll range: ${JSON.stringify(openedViewport)}`
  )
  assert.ok(
    fromBottom(openedViewport) > 8,
    'Opening the tool detail pulled the conversation back to the bottom'
  )
  const readingDistance = fromBottom(openedViewport) + 12
  await control.command('scrollFromBottomAsUser', scroller, { value: String(readingDistance) })
  const nudged = await metrics(anchor)
  assert.ok(
    Math.abs(nudged.top - after.top - 12) <= 8,
    `A 12px nudge moved the tool row by ${nudged.top - after.top}px: ${JSON.stringify({
      before,
      after,
      openedViewport,
      nudged,
      nudgedViewport: await metrics(scroller),
    })}`
  )
  await control.command('scrollFromBottomAsUser', scroller, { value: '0' })
  await control.command('scrollFromBottomAsUser', scroller, { value: String(readingDistance) })
  await control.command('waitFor', output, { stableMs: 250, timeoutMs })
  assert.equal(
    await control.command('getAttribute', anchor, { value: 'aria-expanded' }),
    'true',
    'The tool detail collapsed while the reader scrolled'
  )
  return { before, after, nudged, openedViewport }
}
