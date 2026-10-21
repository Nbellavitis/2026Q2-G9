'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { Logo } from '@/components/Logo'

/**
 * The frame around signing in and signing up.
 *
 * <p>Both pages were a 24rem column centred in the viewport - the phone layout, unchanged, on a
 * monitor. It left most of the screen empty while the form itself ran past the fold: four fields
 * plus a header and a footer link do not fit in a 768px-tall laptop viewport once they are stacked
 * in a single narrow strip.
 *
 * <p>From `lg` the width earns its keep. The brand panel takes the logo and the language switcher
 * out of the form column, which is worth about 64px of the overflow on its own, and the copy in it
 * is the landing page's - the same promise, not a second version of it to keep in sync.
 *
 * <p>The form column stays narrow at every width. A wide login form is not an improvement; the
 * problem was never that 24rem is too little for the form, it was that 24rem was all the page used.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useI18n()

  return (
    <main className="lg:grid lg:min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="hidden lg:flex lg:flex-col lg:justify-between lg:border-r lg:border-line lg:bg-raised lg:px-12 lg:py-10">
        <Link href="/" className="w-fit">
          <Logo />
        </Link>

        <div>
          <p className="text-sm font-medium text-brand">{t('landing.eyebrow')}</p>
          <h2 className="mt-3 font-display text-4xl font-semibold tracking-tight">
            {t('landing.headlineTop')}
            <br />
            {t('landing.headlineBottom')}
          </h2>
          <p className="mt-5 max-w-sm text-muted">{t('landing.lede')}</p>
        </div>

        <div className="flex justify-start">
          <LanguageSwitcher />
        </div>
      </aside>

      <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-12 lg:min-h-0 lg:py-10">
        {/* On lg these two live in the panel beside this column, so they would be a second copy. */}
        <div className="mb-8 flex items-center justify-between lg:hidden">
          <Link href="/">
            <Logo />
          </Link>
          <LanguageSwitcher />
        </div>

        {children}
      </div>
    </main>
  )
}
