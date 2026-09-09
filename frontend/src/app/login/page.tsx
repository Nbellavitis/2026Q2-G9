'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { errorMessage } from '@/lib/format'
import { useAuth } from '@/lib/auth'
import { useI18n } from '@/lib/i18n'
import { AuthShell } from '@/components/AuthShell'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

/*
 * Working credentials for the seeded accounts, with one-click fill. Genuinely useful in front of a
 * class; a printed invitation on a page anyone can open otherwise.
 *
 * <p>Opt in, not opt out. This was `!== 'false'`, which ships the block unless somebody remembers
 * the flag at build time - and nobody did: the credentials went out with the deployed site. A
 * default that is only safe when a person remembers something is not a safe default. The flag is
 * read at build time, so with it unset the block is absent from the bundle rather than hidden in
 * it, and `.env.development` turns it back on for `next dev` without anyone having to think about
 * it.
 *
 * <p>The accounts themselves only exist where `q.seed.enabled` is true, which is the dev profile
 * alone. Publishing the passwords to a database that never had those users is still publishing
 * them: the day someone points a seeded build at the real database, the door is already open.
 */
const SHOW_DEMO_LOGIN = process.env.NEXT_PUBLIC_SHOW_DEMO_LOGIN === 'true'

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
    <AuthShell>
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
    </AuthShell>
  )
}
