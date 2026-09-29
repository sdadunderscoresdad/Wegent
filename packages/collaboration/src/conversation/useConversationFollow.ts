import { useCallback } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

/**
 * Initialization belongs to the conversation intent, after its transcript commits.
 * Content and viewport resizing belong exclusively to the dependency.
 */
export function useConversationFollow() {
  const follow = useStickToBottom({ initial: false, resize: 'instant' })
  const { state } = follow
  const setScrollPosition = useCallback(
    (top: number) => {
      // This dependency accessor writes the DOM and marks the resulting event;
      // it is an imperative API, not an assignment to React render state.
      // eslint-disable-next-line react-hooks/immutability
      state.scrollTop = top
    },
    [state]
  )
  return { ...follow, setScrollPosition }
}
