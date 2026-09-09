'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { errorMessage } from '@/lib/format'
import { useAuth } from '@/lib/auth'
import { useI18n } from '@/lib/i18n'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Logo } from '@/components/Logo'

/*
 * Working credentials for the seeded accounts, with one-click fill. They exist for the live demo
 * and they are genuinely useful there - but this repository is public and the export is static, so
 * they otherwise ship to anyone who opens the deployed sign-in page and hand them a real session.
 * Build with NEXT_PUBLIC_SHOW_DEMO_LOGIN=false to leave them out entirely; the flag is read at
 * build time, so the block is not merely hidden, it is absent from the bundle.
 */
const SHOW_DEMO_LOGIN = process.env.NEXT_PUBLIC_SHOW_DEMO_LOGIN !== 'false'

const DEMO_ACCOUNTS = [
  { roleKey: 'auth.demoOwner', email: 'owner@demo.q', password: 'demo1234' },
  { roleKey: 'auth.demoStaff', email: 'staff@demo.q', password: 'demo1234' },
] as const

export default function LoginPage() {
  const router = useRouter()
  const { login, user, initialising } = useAuth()
  const { t, locale } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!initialising && user) router.replace('/panel')
  }, [initialising, user, router])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email.trim(), password)
      router.replace('/panel')
    } catch (cause) {
      setError(errorMessage(t, cause))
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-12">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/">
          <Logo />
        </Link>
        <LanguageSwitcher />
      </div>

      <h1 className="font-display text-3xl font-semibold tracking-tight">{t('common.signIn')}</h1>
      <p className="mt-2 text-muted">{t('auth.signInSubtitle')}</p>

      <form onSubmit={submit} className="mt-8 space-y-4">
        <Field
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <Field
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Button type="submit" size="lg" block loading={submitting}>
          {t('common.signIn')}
        </Button>
      </form>

      {SHOW_DEMO_LOGIN ? (
      <div className="mt-6 rounded-xl border border-line bg-raised px-4 py-3 text-sm">
        <p className="font-medium">{t('auth.demoTitle')}</p>
        {DEMO_ACCOUNTS.map((account) => (
          <p key={account.email} className="mt-1 text-muted">
            {t(account.roleKey)}: {account.email} · {account.password}
          </p>
        ))}
        <div className="mt-3 flex flex-wrap gap-3">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              className="rounded text-brand hover:underline"
              onClick={() => {
                setEmail(account.email)
                setPassword(account.password)
              }}
            >
              {t('auth.demoUse', { role: t(account.roleKey).toLocaleLowerCase(locale) })}
            </button>
          ))}
        </div>
      </div>
      ) : null}

      <p className="mt-6 text-center text-sm text-muted">
        {t('auth.noAccount')}{' '}
        <Link href="/register" className="font-medium text-brand hover:underline">
          {t('auth.createOne')}
        </Link>
      </p>
    </main>
  )
}
