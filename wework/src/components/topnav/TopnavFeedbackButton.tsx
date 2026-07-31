import { useState } from 'react'
import { MessageSquareWarning } from 'lucide-react'
import { TaskFeedbackDialog } from '@/features/feedback/TaskFeedbackDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'

export function TopnavFeedbackButton() {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        data-testid="topnav-feedback-button"
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.feedback_button')}
        title={t('workbench.feedback_button')}
        onClick={() => setOpen(true)}
      >
        <MessageSquareWarning className="h-4 w-4" />
      </button>
      <TaskFeedbackDialog
        open={open}
        hasActiveTask={false}
        onClose={() => setOpen(false)}
        getTaskContext={() => Promise.resolve({})}
      />
    </>
  )
}
