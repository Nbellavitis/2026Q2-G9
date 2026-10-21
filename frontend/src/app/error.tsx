'use client'

import { useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { LogoMark } from '@/components/Logo'

/**
 * The last line of defence.
 *
 * <p>There is no server here to catch anything: the app is a static export, so a render that throws
 * leaves the customer holding a blank white phone screen with their place in the queue somewhere
 * behind it. This turns that into a sentence and a button, in their own language. Reloading is the
 * right offer rather than `reset()` alone, because the state that caused the throw usually came
 * from a stream that needs re-establishing.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  const { t } = useI18n()

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-12 text-center">
      <span className="mx-auto">
        <LogoMark className="size-8" />
        <span className="sr-only">Q</span>
      </span>
      <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight">
        {t('error.pageTitle')}
      </h1>
      <p className="mt-3 text-muted">{t('error.pageBody')}</p>
      <div className="mt-8 flex justify-center gap-3">
        <Button onClick={() => reset()}>{t('error.tryAgain')}</Button>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {t('error.reload')}
        </Button>
      </div>
    </main>
  )
}
