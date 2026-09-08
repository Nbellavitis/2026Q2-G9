'use client'

import { useEffect, useState } from 'react'

/**
 * Reads a query parameter on the client.
 *
 * Every page that needs an id reads it this way - the staff pages under `/panel`, and the two
 * public shells `/q/` and `/t/`. Ids travel in the query string because a path segment would need a
 * rewrite rule in whatever serves the exported site, which static hosting on S3 cannot express.
 *
 * Deliberately not `useSearchParams`: that forces a Suspense boundary on every page under a static
 * export, and reading the address bar after mount does the same job with less ceremony.
 *
 * Returns `undefined` until resolved, then the value or `null` when absent.
 */
export function useQueryParam(name: string): string | null | undefined {
  const [value, setValue] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    setValue(new URLSearchParams(window.location.search).get(name))
  }, [name])

  return value
}
