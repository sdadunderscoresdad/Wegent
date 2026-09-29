import type { ComponentProps } from 'react'
import { ToolBlocksDisplay as SharedToolBlocksDisplay } from '@wegent/collaboration/conversation'
import { DesktopToolServices } from '../DesktopToolServices'

export function ToolBlocksDisplay(props: ComponentProps<typeof SharedToolBlocksDisplay>) {
  return (
    <DesktopToolServices>
      <SharedToolBlocksDisplay {...props} />
    </DesktopToolServices>
  )
}
