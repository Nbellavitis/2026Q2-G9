'use client'

import { useI18n } from '@/lib/i18n'
import { ButtonLink } from '@/components/ui/Button'
import { LogoMark } from '@/components/Logo'

/**
 * A mistyped or expired link. Next's own 404 is English-only, which is the wrong thing to hand
 * someone whose whole session so far has been in Spanish.
 */
export default function NotFound() {
  const { t } = useI18n()

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-12 text-center">
      <span className="mx-auto">
        <LogoMark className="size-8" />
        <span className="sr-only">Q</span>
      </span>
      <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight">
        {t('notFound.title')}
      </h1>
      <p className="mt-3 text-muted">{t('notFound.body')}</p>
      <div className="mt-8 flex justify-center">
        <ButtonLink href="/">{t('notFound.home')}</ButtonLink>
      </div>
    </main>
  )
}
