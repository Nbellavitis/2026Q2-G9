'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

interface Options<T> {
  /** SSE endpoint, or null to skip the stream and rely on polling alone. */
  url: string | null
  /** Named SSE event carrying the payload. */
  eventName: string
  /** Fetches the resource. Used for the first load and as the polling fallback. */
  load: (signal: AbortSignal) => Promise<T>
  /** How often to re-fetch while the stream is down. */
  pollMs?: number
  enabled?: boolean
}

interface LiveResource<T> {
  data: T | null
  error: ApiError | null
  /** True while the SSE connection is open, so the UI can be honest about how fresh it is. */
  live: boolean
  loading: boolean
  refresh: () => void
}

/**
 * Keeps one resource in sync with the server.
 *
 * The first read is a plain fetch rather than the stream, because `EventSource` cannot report a
 * status code - a missing ticket has to surface as "this ticket does not exist", not as a silent
 * connection failure. Once that succeeds the stream takes over and pushes every change.
 *
 * Polling is the safety net, not the mechanism: it only runs while the stream is down, so a proxy
 * that blocks `text/event-stream` degrades to a slightly slower app instead of a broken one.
 */
export function useLiveResource<T>({
  url,
  eventName,
  load,
  pollMs = 5000,
  enabled = true,
}: Options<T>): LiveResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(enabled)
  const [nonce, setNonce] = useState(0)

  const loadRef = useRef(load)
  loadRef.current = load

  /*
   * Three things write `data`: the first load, an explicit refresh, and the stream. They race.
   * A poll issued while the stream was down could resolve seconds later - after the stream had
   * reconnected and pushed a newer snapshot - and roll the board back to the older state, which on
   * a queue looks exactly like a customer reappearing after being served. Each read takes a ticket
   * before it starts; a result whose ticket is older than what has already been applied is dropped.
   */
  const nextIssue = useRef(0)
  const lastApplied = useRef(-1)

  const apply = useCallback((value: T, issue: number) => {
    if (issue < lastApplied.current) return
    lastApplied.current = issue
    setData(value)
    setError(null)
  }, [])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  // Initial load, and any explicit refresh.
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    const issue = nextIssue.current++

    setLoading(true)
    loadRef
      .current(controller.signal)
      .then((value) => {
        if (cancelled) return
        apply(value, issue)
      })
      .catch((cause: unknown) => {
        if (cancelled || controller.signal.aborted) return
        setError(cause instanceof ApiError ? cause : new ApiError(0, 'UNKNOWN', 'Something went wrong.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled, nonce, apply])

  // The stream.
  useEffect(() => {
    if (!enabled || !url) return

    const source = new EventSource(url)

    const onPayload = (event: MessageEvent<string>) => {
      try {
        // A pushed frame is by definition the freshest thing we have, so it takes a ticket at the
        // moment it arrives rather than when the connection opened.
        apply(JSON.parse(event.data) as T, nextIssue.current++)
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    }

    source.addEventListener(eventName, onPayload as EventListener)
    source.onopen = () => setLive(true)
    source.onerror = () => setLive(false)

    return () => {
      source.removeEventListener(eventName, onPayload as EventListener)
      source.close()
      setLive(false)
    }
  }, [enabled, url, eventName, apply])

  // Fallback polling, active only while the stream is not carrying updates.
  useEffect(() => {
    if (!enabled || live) return
    // One controller for the whole interval, aborted on cleanup: the old code minted a fresh one
    // per tick and never aborted any of them, so unmounting the page - or the stream coming back -
    // left every in-flight poll running to completion.
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      const issue = nextIssue.current++
      loadRef.current(controller.signal).then(
        (value) => {
          if (!controller.signal.aborted) apply(value, issue)
        },
        () => {
          // Keep showing the last good state rather than blanking the screen on a blip.
        },
      )
    }, pollMs)

    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [enabled, live, pollMs, apply])

  return { data, error, live, loading, refresh }
}
