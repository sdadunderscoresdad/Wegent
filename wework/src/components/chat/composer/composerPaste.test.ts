import { describe, expect, test } from 'vitest'
import {
  composerClipboardText,
  htmlClipboardToComposerText,
  singlePastedUrl,
  wrapComposerSelectionWithPastedUrl,
} from './composerPaste'

function clipboard(entries: Record<string, string>): { getData: (type: string) => string } {
  return {
    getData: (type: string) => entries[type] ?? '',
  }
}

describe('composerClipboardText', () => {
  test('uses plain text when the HTML has no links', () => {
    expect(
      composerClipboardText(clipboard({ 'text/html': '<p>hello</p>', 'text/plain': 'hello' }))
    ).toBe('hello')
  })

  test('converts HTML anchors into markdown links instead of losing the href', () => {
    expect(
      composerClipboardText(
        clipboard({
          'text/html':
            '<p>see <a href="https://github.com/wecode-ai/Wegent/pull/2350">my pr</a> now</p>',
          'text/plain': 'see my pr now',
        })
      )
    ).toBe('see [my pr](https://github.com/wecode-ai/Wegent/pull/2350) now')
  })

  test('keeps anchors without a recognized URL as their visible text', () => {
    expect(htmlClipboardToComposerText('<a href="mailto:a@b.com">mail</a>')).toBeUndefined()
  })
})

describe('singlePastedUrl', () => {
  test('accepts a bare URL with trailing prose punctuation', () => {
    expect(singlePastedUrl('https://example.com/page.')).toBe('https://example.com/page')
  })

  test('rejects text that is not exactly one URL', () => {
    expect(singlePastedUrl('see https://example.com/page')).toBeUndefined()
    expect(singlePastedUrl('example.com/page')).toBeUndefined()
  })
})

describe('wrapComposerSelectionWithPastedUrl', () => {
  test('wraps the selected text with the pasted URL', () => {
    const expectedValue = 'a [b](https://example.com/x) c'
    expect(
      wrapComposerSelectionWithPastedUrl({
        value: 'a b c',
        selectionStart: 2,
        selectionEnd: 3,
        pastedText: 'https://example.com/x',
      })
    ).toEqual({ value: expectedValue, caretOffset: 'a [b](https://example.com/x)'.length })
  })

  test('escapes label characters that would break the markdown link', () => {
    const expectedValue = 'pick [a\\]b](https://example.com/x)'
    expect(
      wrapComposerSelectionWithPastedUrl({
        value: 'pick a]b',
        selectionStart: 5,
        selectionEnd: 8,
        pastedText: 'https://example.com/x',
      })
    ).toEqual({ value: expectedValue, caretOffset: 'pick [a\\]b](https://example.com/x)'.length })
  })

  test('does not wrap empty or multiline selections', () => {
    expect(
      wrapComposerSelectionWithPastedUrl({
        value: 'a b',
        selectionStart: 1,
        selectionEnd: 1,
        pastedText: 'https://example.com/x',
      })
    ).toBeUndefined()
    expect(
      wrapComposerSelectionWithPastedUrl({
        value: 'a\nb',
        selectionStart: 0,
        selectionEnd: 3,
        pastedText: 'https://example.com/x',
      })
    ).toBeUndefined()
  })

  test('does not wrap when the clipboard holds more than a URL', () => {
    expect(
      wrapComposerSelectionWithPastedUrl({
        value: 'a b',
        selectionStart: 2,
        selectionEnd: 3,
        pastedText: 'see https://example.com/x',
      })
    ).toBeUndefined()
  })
})
