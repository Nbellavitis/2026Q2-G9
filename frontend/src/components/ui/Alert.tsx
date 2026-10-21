import type { ReactNode } from 'react'
import { cx } from '@/lib/format'

type Kind = 'error' | 'info' | 'success' | 'warn'

const KINDS: Record<Kind, string> = {
  error: 'bg-danger-soft text-danger border-danger/20',
  info: 'bg-raised text-muted border-line',
  success: 'bg-sage-soft text-sage border-sage/20',
  warn: 'bg-warn-soft text-warn border-warn/20',
}

/*
 * Only `error` and `success` get a role. Both mark something that just happened and that a screen
 * reader user would otherwise never learn about. `info` and `warn` are frequently static page
 * content - "this queue is paused" is there on load, not an event - and announcing them on every
 * poll would turn the customer's ticket into a stream of interruptions.
 */
const ROLES: Partial<Record<Kind, string>> = { error: 'alert', success: 'status' }

export function Alert({ kind = 'info', children }: { kind?: Kind; children: ReactNode }) {
  return (
    <div role={ROLES[kind]} className={cx('rounded-xl border px-4 py-3 text-sm', KINDS[kind])}>
      {children}
    </div>
  )
}
