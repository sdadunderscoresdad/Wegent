import assert from 'node:assert/strict'

const PROMPT = 'WEWORK_DESKTOP_E2E_FINAL_ANSWER_HISTORY_READING'
const PROCESS = 'Preparing the final response while the reader views an earlier turn.'
const ANSWER = `WEWORK_DESKTOP_E2E_HISTORY_READING_ANSWER\n\n${Array.from(
  { length: 16 },
  (_, index) => `Final paragraph ${index + 1}: streaming below the reader must not move history.`
).join('\n\n')}`

async function readStableHistorySample(control, anchors, timeoutMs) {
  let sample
  const deadline = Date.now() + timeoutMs
  do {
    sample = JSON.parse(await control.command('getScrollStabilitySample', anchors))
    if (sample.done) break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.ok(sample.done && sample.frames.length >= 12, 'Insufficient history frame samples')
  assert.equal(sample.missingFrames, 0, 'The historical paragraph disappeared')
  const tops = sample.frames.map(frame => frame.anchorTop)
  const spread = Math.max(...tops) - Math.min(...tops)
  assert.ok(spread <= 8, `Final output moved the historical paragraph by ${spread}px`)
  return sample.frames.map(frame => frame.scrollHeight)
}

/** Model-only fixture and real-renderer assertions, invoked by rendering-extensions. */
export function createFinalAnswerReadingRegression({
  sse,
  streamingEvents,
  textDeltaEvents,
  reasoningEvents,
}) {
  let release
  const ready = new Promise(resolve => {
    release = resolve
  })
  let complete
  const completion = new Promise(resolve => {
    complete = resolve
  })
  return {
    matches: body => JSON.stringify(body.input ?? []).includes(PROMPT),
    async respond(response, id) {
      const process = streamingEvents(id, PROCESS, 'commentary')
      const answer = streamingEvents(`${id}-final`, ANSWER)
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(
        sse([
          ...process.start,
          ...textDeltaEvents(process.itemId, PROCESS),
          ...process.finish.slice(0, -1),
          ...reasoningEvents(`${id}-reasoning`, 'Preparing the final answer').map(event => ({
            ...event,
            output_index: 1,
          })),
        ])
      )
      response.flush?.()
      await ready
      // Both messages belong to the same response, with distinct output indices.
      const atAnswerIndex = events =>
        events.map(event => ('output_index' in event ? { ...event, output_index: 2 } : event))
      response.write(sse(atAnswerIndex(answer.start.slice(1))))
      let offset = 0
      for (const chunk of ANSWER.match(/[\s\S]{1,32}/g) ?? []) {
        response.write(sse(atAnswerIndex(textDeltaEvents(answer.itemId, chunk, offset))))
        response.flush?.()
        offset += chunk.length
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      await completion
      response.end(sse([...atAnswerIndex(answer.finish.slice(0, -1)), process.finish.at(-1)]))
    },
    async verify({ control, scope, historyText, timeoutMs }) {
      const composer = `${scope} [data-testid="chat-message-input"][contenteditable="true"]`
      const scroller = `${scope} [data-testid="desktop-workbench-content"]`
      const anchors = `${scope} [data-testid="assistant-message-content"] [data-scroll-anchor]`
      const finalToggle = `${scope} [data-testid="message-assistant"]:last-of-type [data-testid="final-processing-toggle"]`
      await control.command('fill', composer, { value: PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      try {
        await control.command('waitFor', `${scope} [data-testid="process-text-block"]`, {
          text: PROCESS,
          timeoutMs,
        })
        await control.command('scrollIntoViewAsUser', anchors, {
          text: historyText,
          value: 'start',
        })
        const marked = scope + ' [data-e2e-anchor-id="final-answer-history-reader"]'
        await control.command('markElementWithText', anchors, {
          text: historyText,
          value: 'final-answer-history-reader',
        })
        await control.command('waitFor', marked, { visible: true, stableMs: 200, timeoutMs })
        const [viewport] = JSON.parse(await control.command('getElementMetrics', scroller))
        assert.ok(
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 8,
          'The reader did not leave the live answer at the bottom'
        )
        await control.command('startScrollStabilitySampling', anchors, {
          value: JSON.stringify({
            anchorText: historyText,
            durationMs: 3000,
            scrollerSelector: scroller,
          }),
        })
        release()
        await control.command('waitFor', `${scope} [data-testid="assistant-message-content"]`, {
          text: ANSWER.split('\n\n').at(-1),
          timeoutMs,
        })
        // Paragraph boundaries are DOM elements, not Markdown's blank lines.
        // Verify every paragraph through the same per-element text contract.
        const paragraphs = await control.command(
          'getText',
          `${scope} [data-testid="assistant-message-content"] p`
        )
        assert.ok(
          paragraphs.includes(ANSWER.split('\n\n').join('\n')),
          'The final answer lost or reordered a paragraph'
        )
        await control.command('waitFor', `${scope} [data-testid="process-text-block"]`, {
          text: PROCESS,
          timeoutMs,
        })
        assert.equal(
          await control.command('getAttribute', finalToggle, { value: 'aria-expanded' }),
          'true',
          'Final text collapsed processing before the turn completed'
        )
        await control.command(
          'markElementWithText',
          `${scope} [data-testid="assistant-message-content"]`,
          {
            text: ANSWER.split('\n\n')[0],
            value: 'final-answer-before-completion',
          }
        )
        const heights = await readStableHistorySample(control, anchors, timeoutMs)
        assert.ok(
          Math.max(...heights) - Math.min(...heights) > 8,
          'The sampling window missed the streamed answer layout changes'
        )
        // Sample completion separately so a slow stream cannot consume its window.
        await control.command('startScrollStabilitySampling', anchors, {
          value: JSON.stringify({
            anchorText: historyText,
            durationMs: 1500,
            scrollerSelector: scroller,
          }),
        })
        complete()
        await control.command('waitFor', `${scope} [data-testid="send-message-button"]`, {
          timeoutMs,
        })
        await control.command('waitFor', `${finalToggle}[aria-expanded="false"]`, { timeoutMs })
        const completedHeights = await readStableHistorySample(control, anchors, timeoutMs)
        assert.ok(
          completedHeights[0] - completedHeights.at(-1) > 8,
          'Completion did not collapse the visible processing content'
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${scope} [data-e2e-anchor-id="final-answer-before-completion"]`
            )
          ),
          1,
          'Collapsing processing replaced the final answer node'
        )
        await control.command('waitFor', `${scope} [data-testid="scroll-to-bottom-button"]`, {
          timeoutMs,
        })
        await control.command('click', `${scope} [data-testid="scroll-to-bottom-button"]`)
      } finally {
        release()
        complete()
      }
    },
  }
}
