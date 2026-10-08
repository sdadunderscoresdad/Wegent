import { expect, test } from 'vitest'
import { buildUserTurnsForNavigation } from '../../../../packages/collaboration/src/conversation/turnNavigationUtils'

test('does not bind an unloaded turn to a different page with the same message index', () => {
  const navigation = [
    {
      id: 'old-user',
      turnId: 'old-turn',
      turnIndex: 0,
      messageIndex: 0,
      promptPreview: 'Old prompt',
      responsePreview: '',
      cursor: 'offset:0',
    },
    {
      id: 'new-user',
      turnId: 'new-turn',
      turnIndex: 1,
      messageIndex: 10,
      promptPreview: 'New prompt',
      responsePreview: '',
      cursor: 'offset:10',
    },
  ]
  const newest = {
    id: 'new-user',
    turnId: 'new-turn',
    role: 'user' as const,
    content: 'New prompt',
    runtimeMessageIndex: 0,
  }
  const initial = buildUserTurnsForNavigation([newest], navigation)
  expect(initial.map(turn => turn.id)).toEqual(['old-user', 'new-user'])
  expect(initial.map(turn => turn.loaded)).toEqual([false, true])
  const loaded = buildUserTurnsForNavigation(
    [{ ...newest, id: 'old-user', turnId: 'old-turn', content: 'Old prompt' }, newest],
    navigation
  )
  expect(loaded.map(turn => turn.id)).toEqual(['old-user', 'new-user'])
  expect(loaded.map(turn => turn.loaded)).toEqual([true, true])
})
