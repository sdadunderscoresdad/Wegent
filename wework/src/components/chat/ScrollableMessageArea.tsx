import {
  ScrollableMessageArea as SharedScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import { DesktopToolServices } from './DesktopToolServices'
import {
  useDesktopConversationPresentation,
  type DesktopConversationPresentationProp,
} from './useDesktopConversationPresentation'

export function ScrollableMessageArea({
  workspacePath,
  imageTarget,
  ...props
}: Omit<ScrollableMessageAreaProps, DesktopConversationPresentationProp> & {
  workspacePath?: string
  imageTarget?: { deviceId: string; workspacePath: string } | null
}) {
  const presentation = useDesktopConversationPresentation(props.messages, workspacePath)
  return (
    <DesktopToolServices imageTarget={imageTarget}>
      <SharedScrollableMessageArea {...props} {...presentation} />
    </DesktopToolServices>
  )
}
