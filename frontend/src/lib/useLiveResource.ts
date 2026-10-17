'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

interface Options<T> {
  /** SSE endpoint, or null to skip the stream and rely on polling alone. */
  url: string | null
  /**
   * Resolves the WebSocket address to open, when there is no SSE `url`. `null` means there is no
   * WebSocket here (keep polling); a rejection means try again later (the staff ticket request
   * failed, say). Must be a stable function: a new one reopens the connection.
   */
  socket?: (() => Promise<string | null>) | undefined
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
/**
 * API Gateway drops a WebSocket after ten idle minutes. A ping every five keeps it open; it is
 * answered by API Gateway itself, so it does not invoke any Lambda.
 */
const PING_MS = 5 * 60 * 1000
const RECONNECT_MAX_MS = 30_000

export function useLiveResource<T>({
  url,
  socket,
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

  // The WebSocket, where the deployment has one. It closes on its own after two hours (API
  // Gateway's limit) or when the network changes: either way it reconnects, with backoff, and on
  // every reconnection reloads over REST whatever was missed while it was down.
  useEffect(() => {
    if (!enabled || url || !socket) return

    let stopped = false
    let opened = false
    let attempt = 0
    let connection: WebSocket | null = null
    let reconnectTimer: number | undefined
    let pingTimer: number | undefined

    const reconnectLater = () => {
      if (stopped) return
      const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** attempt++)
      reconnectTimer = window.setTimeout(() => void open(), delay)
    }

    const open = async () => {
      let address: string | null
      try {
        address = await socket()
      } catch {
        reconnectLater()
        return
      }
      if (stopped || !address) return

      connection = new WebSocket(address)
      connection.onopen = () => {
        attempt = 0
        setLive(true)
        if (opened) refresh()
        opened = true
        pingTimer = window.setInterval(() => {
          if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ action: 'ping' }))
        }, PING_MS)
      }
      connection.onmessage = (event: MessageEvent<string>) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; data?: unknown }
          // Same freshness rule as an SSE frame: a push is the newest thing we have.
          if (message.type === eventName) apply(message.data as T, nextIssue.current++)
          // Too large to push in one frame (a very long queue): fetch it instead.
          else if (message.type === 'queue.changed') refresh()
        } catch {
          // A malformed frame is not worth tearing the connection down for.
        }
      }
      connection.onclose = () => {
        window.clearInterval(pingTimer)
        setLive(false)
        reconnectLater()
      }
    }

    void open()
    return () => {
      stopped = true
      window.clearTimeout(reconnectTimer)
      window.clearInterval(pingTimer)
      connection?.close()
      setLive(false)
    }
  }, [enabled, url, socket, eventName, apply, refresh])

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
