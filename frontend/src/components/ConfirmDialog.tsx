'use client'

import { useEffect, useId, useRef } from 'react'
import { useI18n } from '@/lib/i18n'
import { Button } from './ui/Button'

/**
 * Used for the moves that cannot be taken back from the customer's side: giving up a place in the
 * line, closing a queue that still has people in it, deleting a queue.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const describedBy = useId()

  /*
   * Every call site passes `onCancel` as a fresh inline arrow, so its identity changes on each
   * parent render. Depending on it directly meant an SSE push arriving while the dialog was open
   * tore the effect down and re-ran it: focus was pulled off whatever the operator had tabbed to
   * and put back on the confirm button. On the board that button is destructive, so someone who
   * had deliberately moved to Cancel could press Enter and remove a real customer from the line.
   * The ref keeps the callback current while the effect stays keyed on `open` alone.
   */
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel

  /*
   * `aria-modal` tells assistive technology the rest of the page is inert; it does not make Tab
   * behave that way. Without the cycle below, the third Tab out of this dialog lands on the
   * "Leave the queue" button behind it - a keyboard user could confirm a destructive action they
   * can no longer see. Focus also has to go back where it came from, or dismissing the dialog
   * drops the caret at the top of the document.
   */
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelRef.current()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // Scrolling the board out from under a confirmation is disorienting, and on iOS it is what
    // makes a dialog feel like it is floating over the wrong page.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      opener?.focus?.()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // Without this the dialog announces its title and its two buttons, and never the sentence
      // that says what confirming actually does.
      aria-describedby={describedBy}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/35 p-4 backdrop-blur-[2px] sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        ref={panelRef}
        className="animate-in w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-lift"
      >
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        <p id={describedBy} className="mt-2 text-sm text-muted">
          {description}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
