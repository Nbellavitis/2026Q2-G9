'use client'

import { cx, formatWait, formatWaitNeutral } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/**
 * A waiting time, in the slot where a number goes.
 *
 * <p>The display face is this product's way of saying "here is the figure that matters", so it is
 * only honest while the value is a figure. At the ends of the range the same helpers return a
 * sentence — "You're next", "No wait" — and a sentence set at 3rem in a serif reads as a headline
 * and wraps to three lines on a phone. One slot, two treatments, chosen by what the value actually
 * is rather than by where it happens to be rendered.
 */
export function WaitFigure({
  minutes,
  neutral = false,
  className,
}: {
  minutes?: number | null
  neutral?: boolean
  className?: string
}) {
  const { t } = useI18n()
  const text = neutral ? formatWaitNeutral(t, minutes) : formatWait(t, minutes)

  return typeof minutes === 'number' && minutes > 0 ? (
    <div className={cx('font-display text-2xl leading-tight font-semibold tnum text-balance sm:text-3xl', className)}>
      {text}
    </div>
  ) : (
    <div className={cx('text-lg leading-snug font-medium text-balance', className)}>{text}</div>
  )
}
