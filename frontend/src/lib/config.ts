'use client'

/**
 * What the site needs to know about the infrastructure it runs on, read at runtime.
 *
 * The Cognito ids only exist after `terraform apply`, but the site is built before it - so they
 * cannot be baked into the bundle. Terraform writes them to `config.json` next to the site, and this
 * reads it once per page load. In development there is no such file: the same values come from
 * `NEXT_PUBLIC_COGNITO_*` in `.env.local`.
 */
export interface RuntimeConfig {
  region: string
  userPoolId: string
  userPoolClientId: string
  /** The realtime WebSocket. Absent in development, where the local backend streams over SSE. */
  websocketUrl?: string
}

let pending: Promise<RuntimeConfig> | null = null

export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  pending ??= fetchConfig().catch((cause) => {
    // Let a later call try again instead of caching the failure for the life of the tab.
    pending = null
    throw cause
  })
  return pending
}

async function fetchConfig(): Promise<RuntimeConfig> {
  const fromEnv = {
    region: process.env.NEXT_PUBLIC_COGNITO_REGION,
    userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
    userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  }
  if (fromEnv.region && fromEnv.userPoolId && fromEnv.userPoolClientId) {
    return fromEnv as RuntimeConfig
  }

  const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/config.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`config.json answered ${response.status}`)
  return (await response.json()) as RuntimeConfig
}
