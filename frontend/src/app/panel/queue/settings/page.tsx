'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/format'
import { useAuth } from '@/lib/auth'
import { useI18n, type Translate } from '@/lib/i18n'
import { useQueryParam } from '@/lib/useQueryParam'
import type { CallStrategy, LaneCapacityMode, NoShowPolicy, QueueLaneView, QueueView } from '@/lib/types'
import { Alert } from '@/components/ui/Alert'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Field, SelectField } from '@/components/ui/Field'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageLoader } from '@/components/PageLoader'

const policyHelp = (t: Translate): Record<NoShowPolicy, string> => ({
  KEEP_POSITION: t('settings.policyKeepHelp'),
  MOVE_BACK: t('settings.policyMoveBackHelp'),
  MOVE_TO_END: t('settings.policyMoveEndHelp'),
  REMOVE: t('settings.policyRemoveHelp'),
})

/** Everything about how a queue behaves. Owner-only; the API enforces that too. */
export default function QueueSettingsPage() {
  const router = useRouter()
  const queueId = useQueryParam('id')
  const { isOwner } = useAuth()
  const { t } = useI18n()

  const [queue, setQueue] = useState<QueueView | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [policy, setPolicy] = useState<NoShowPolicy>('MOVE_TO_END')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // Lanes save on the spot; everything else waits for the button. Say which state you are in.
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [laneToDelete, setLaneToDelete] = useState<QueueLaneView | null>(null)
  const [laneDraft, setLaneDraft] = useState({ name: '', minPartySize: '1', maxPartySize: '', priority: '0', capacityMode: 'GROUPS' as LaneCapacityMode, maxSize: '', timeFactor: '1' })
  const [laneBusy, setLaneBusy] = useState(false)
  const [laneFeedback, setLaneFeedback] = useState<{ kind: 'info' | 'error'; message: string } | null>(null)
  const [callStrategy, setCallStrategy] = useState<CallStrategy>('GLOBAL_AGE')

  /*
   * `t` is rebuilt whenever the locale changes, so listing it as a dependency here meant switching
   * EN/ES re-ran this effect, re-fetched the queue, and called setForm() with the server's values -
   * silently discarding every unsaved edit on the page. It is only needed for the error message, so
   * it travels in a ref and the effect keys on the queue alone.
   */
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    if (!queueId) return
    api.queues.get(queueId).then(
      (loaded) => {
        setQueue(loaded)
        setPolicy(loaded.noShowPolicy)
        setCallStrategy(loaded.callStrategy)
        setForm({
          name: loaded.name,
          description: loaded.description ?? '',
          serviceStations: String(loaded.serviceStations),
          defaultServiceMinutes: String(loaded.defaultServiceMinutes),
          maxSize: loaded.maxSize === undefined ? '' : String(loaded.maxSize),
          gracePeriodSeconds: String(loaded.gracePeriodSeconds),
          moveBackPositions: String(loaded.moveBackPositions),
          notifyAtPosition: loaded.notifyAtPosition === undefined ? '' : String(loaded.notifyAtPosition),
          notifyAtMinutes: loaded.notifyAtMinutes === undefined ? '' : String(loaded.notifyAtMinutes),
        })
      },
      (cause: unknown) => setError(errorMessage(tRef.current, cause)),
    )
  }, [queueId])

  const update = (key: string) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [key]: event.target.value }))
    setSaved(false)
    setDirty(true)
  }

  const save = async () => {
    if (!queueId) return
    setError(null)
    setSaving(true)
    try {
      // An empty box means "no limit" / "don't notify", which the API needs told explicitly.
      const updated = await api.queues.update(queueId, {
        name: form.name?.trim(),
        description: form.description?.trim() ?? '',
        serviceStations: Number(form.serviceStations),
        defaultServiceMinutes: Number(form.defaultServiceMinutes),
        maxSize: form.maxSize ? Number(form.maxSize) : undefined,
        clearMaxSize: !form.maxSize,
        gracePeriodSeconds: Number(form.gracePeriodSeconds),
        noShowPolicy: policy,
        moveBackPositions: Number(form.moveBackPositions),
        notifyAtPosition: form.notifyAtPosition ? Number(form.notifyAtPosition) : undefined,
        clearNotifyAtPosition: !form.notifyAtPosition,
        notifyAtMinutes: form.notifyAtMinutes ? Number(form.notifyAtMinutes) : undefined,
        clearNotifyAtMinutes: !form.notifyAtMinutes,
        callStrategy,
      })
      setQueue(updated)
      setSaved(true)
      setDirty(false)
    } catch (cause) {
      setError(errorMessage(t, cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!queueId) return
    try {
      await api.queues.remove(queueId)
      router.replace('/panel')
    } catch (cause) {
      setError(errorMessage(t, cause))
      setConfirmDelete(false)
    }
  }

  const refreshLanes = async () => {
    if (!queueId) return
    const lanes = await api.queues.lanes(queueId)
    setQueue((current) => current ? { ...current, lanes } : current)
  }

  const addLane = async () => {
    if (!queueId || !laneDraft.name.trim()) return
    setLaneBusy(true)
    setError(null)
    setLaneFeedback(null)
    try {
      await api.queues.createLane(queueId, {
        name: laneDraft.name.trim(),
        minPartySize: Number(laneDraft.minPartySize),
        maxPartySize: laneDraft.maxPartySize ? Number(laneDraft.maxPartySize) : null,
        priority: Number(laneDraft.priority),
        capacityMode: laneDraft.capacityMode,
        maxSize: laneDraft.maxSize ? Number(laneDraft.maxSize) : null,
        timeFactor: Number(laneDraft.timeFactor),
        active: true,
      })
      setLaneDraft({ ...laneDraft, name: '' })
      await refreshLanes()
      setLaneFeedback({ kind: 'info', message: t('lanes.added') })
    } catch (cause) {
      setLaneFeedback({ kind: 'error', message: errorMessage(t, cause) })
    } finally {
      setLaneBusy(false)
    }
  }

  const toggleLane = async (lane: QueueLaneView) => {
    if (!queueId) return
    setLaneBusy(true)
    setError(null)
    setLaneFeedback(null)
    try {
      await api.queues.updateLane(queueId, lane.id, {
        name: lane.name,
        minPartySize: lane.minPartySize,
        maxPartySize: lane.maxPartySize ?? null,
        priority: lane.priority,
        capacityMode: lane.capacityMode,
        maxSize: lane.maxSize ?? null,
        timeFactor: lane.timeFactor,
        active: !lane.active,
      })
      await refreshLanes()
      setLaneFeedback({
        kind: 'info',
        message: t('lanes.toggled', {
          name: lane.name,
          state: lane.active ? t('lanes.stateOff') : t('lanes.stateOn'),
        }),
      })
    } catch (cause) {
      setLaneFeedback({ kind: 'error', message: errorMessage(t, cause) })
    } finally {
      setLaneBusy(false)
    }
  }

  const deleteLane = async (lane: QueueLaneView) => {
    if (!queueId) return
    setLaneBusy(true)
    setError(null)
    setLaneFeedback(null)
    try {
      await api.queues.removeLane(queueId, lane.id)
      await refreshLanes()
      setLaneFeedback({ kind: 'info', message: t('lanes.deleted', { name: lane.name }) })
    } catch (cause) {
      setLaneFeedback({ kind: 'error', message: errorMessage(t, cause) })
    } finally {
      setLaneBusy(false)
    }
  }

  if (queueId === null) return <Alert kind="error">{t('board.noQueueSelected')}</Alert>
  if (!queue) return error ? <Alert kind="error">{error}</Alert> : <PageLoader label={t('settings.loading')} />

  return (
    /*
      The form column stays narrow on purpose - a settings form is easier to read at 42rem than
      stretched across a monitor. What the extra width buys is not a wider form but a place to stand:
      seven long cards meant scrolling to find the one you came for.
    */
    <div className="mx-auto max-w-7xl">
      <div className="xl:grid xl:grid-cols-[15rem_minmax(0,42rem)] xl:items-start xl:justify-center xl:gap-10">
        <aside className="hidden xl:block">
          <nav aria-label={t('settings.title')} className="sticky top-24 space-y-1 text-sm">
            {(
              [
                ['strategy', 'lanes.strategyTitle'],
                ['basics', 'settings.basics'],
                ['lanes', 'lanes.title'],
                ['waiting-times', 'settings.waitingTimes'],
                ['no-shows', 'settings.noShowTitle'],
                ['notifications', 'settings.notifications'],
              ] as const
            ).map(([id, key]) => (
              <a
                key={id}
                href={`#${id}`}
                className="block truncate rounded-lg px-3 py-2 text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                {t(key)}
              </a>
            ))}
          </nav>
        </aside>

        <div className="max-w-2xl space-y-6">
      <header>
        <Link href={`/panel/queue?id=${queue.id}`} className="text-sm text-muted hover:text-ink">
          ← {t('settings.backToBoard')}
        </Link>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">{queue.name}</h1>
        <p className="mt-1 text-sm text-muted">{t('settings.title')}</p>
      </header>

      {!isOwner ? (
        <Alert kind="info">{t('settings.ownerOnly')}</Alert>
      ) : null}

      <div className="space-y-6">
        <section id="strategy" className="scroll-mt-24">
        <Card>
          <CardHeader title={t('lanes.strategyTitle')} description={t('lanes.strategyHint')} />
          <SelectField
            label={t('lanes.strategyLabel')}
            value={callStrategy}
            onChange={(event) => {
              setCallStrategy(event.target.value as CallStrategy)
              setSaved(false)
              setDirty(true)
            }}
          >
            <option value="GLOBAL_AGE">{t('lanes.strategyOldest')}</option>
            <option value="LANE_PRIORITY">{t('lanes.strategyPriority')}</option>
            <option value="ROUND_ROBIN">{t('lanes.strategyRoundRobin')}</option>
          </SelectField>
        </Card>
        </section>

        <section id="basics" className="scroll-mt-24">
        <Card>
          <CardHeader title={t('settings.basics')} />
          <div className="space-y-4">
            <Field label={t('panel.queueName')} value={form.name ?? ''} onChange={update('name')} maxLength={120} required />
            <Field
              label={t('panel.description')}
              optional
              value={form.description ?? ''}
              onChange={update('description')}
              maxLength={500}
            />
          </div>
        </Card>
        </section>

        <section id="lanes" className="scroll-mt-24">
        <Card>
          <CardHeader title={t('lanes.title')} description={t('lanes.hint')} />
          <p className="mb-4 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
            {t('settings.appliesImmediately')}
          </p>
          <div className="space-y-3">
            {laneFeedback ? <Alert kind={laneFeedback.kind}>{laneFeedback.message}</Alert> : null}
            {(queue.lanes ?? []).map((lane) => (
              <div
                key={lane.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-3"
              >
                <div>
                  <p className="font-medium">
                    {lane.name}
                    {!lane.active ? (
                      <span className="ml-2 text-xs font-normal text-faint">
                        {t('lanes.stateOff')}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted">
                    {t('lane.range', { min: lane.minPartySize, max: lane.maxPartySize ?? '∞' })}
                    {' · '}
                    {t('lanes.timeFactorSummary', { factor: lane.timeFactor })}
                  </p>
                  {lane.active ? (
                    <p id={`${lane.id}-why-disabled`} className="mt-1 text-xs text-faint">
                      {t('lanes.closeBeforeDeleting')}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    loading={laneBusy}
                    disabled={laneBusy || !isOwner}
                    onClick={() => void toggleLane(lane)}
                  >
                    {lane.active ? t('lanes.disable') : t('lanes.enable')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={laneBusy || lane.active || !isOwner}
                    // A `title` on a disabled control is unreachable by keyboard and unannounced by
                    // a screen reader, so the reason it is unavailable was invisible to exactly the
                    // people who most needed it. The visible note below carries it instead.
                    aria-describedby={lane.active ? `${lane.id}-why-disabled` : undefined}
                    onClick={() => setLaneToDelete(lane)}
                  >
                    {t('lanes.delete')}
                  </Button>
                </div>
              </div>
            ))}
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void addLane()
              }}
              className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2"
            >
              <Field
                label={t('lanes.name')}
                value={laneDraft.name}
                onChange={(event) => setLaneDraft({ ...laneDraft, name: event.target.value })}
                placeholder={t('lanes.namePlaceholder')}
                required
              />
              <Field
                label={t('lanes.min')}
                type="number"
                min={1}
                value={laneDraft.minPartySize}
                onChange={(event) => setLaneDraft({ ...laneDraft, minPartySize: event.target.value })}
                required
              />
              <Field
                label={t('lanes.max')}
                optional
                type="number"
                min={1}
                value={laneDraft.maxPartySize}
                onChange={(event) => setLaneDraft({ ...laneDraft, maxPartySize: event.target.value })}
              />
              <Field
                label={t('lanes.timeFactor')}
                type="number"
                min={0.1}
                step="any"
                value={laneDraft.timeFactor}
                onChange={(event) => setLaneDraft({ ...laneDraft, timeFactor: event.target.value })}
                hint={t('lanes.timeFactorHint')}
                required
              />
              <SelectField
                label={t('lanes.capacityMode')}
                value={laneDraft.capacityMode}
                onChange={(event) =>
                  setLaneDraft({ ...laneDraft, capacityMode: event.target.value as LaneCapacityMode })
                }
              >
                <option value="GROUPS">{t('lanes.capacityGroups')}</option>
                <option value="PERSONS">{t('lanes.capacityPersons')}</option>
              </SelectField>
              <Field
                label={t('lanes.capacity')}
                optional
                type="number"
                min={1}
                value={laneDraft.maxSize}
                onChange={(event) => setLaneDraft({ ...laneDraft, maxSize: event.target.value })}
              />
              <Button type="submit" loading={laneBusy} disabled={!isOwner}>
                {t('lanes.add')}
              </Button>
            </form>
          </div>
        </Card>
        </section>

        <section id="waiting-times" className="scroll-mt-24">
        <Card>
          <CardHeader
            title={t('settings.waitingTimes')}
            description={t('settings.waitingTimesHint')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('panel.servicePoints')}
              type="number"
              min={1}
              value={form.serviceStations ?? ''}
              onChange={update('serviceStations')}
              hint={t('settings.servicePointsHint')}
              required
            />
            <Field
              label={t('panel.typicalService')}
              type="number"
              min={1}
              value={form.defaultServiceMinutes ?? ''}
              onChange={update('defaultServiceMinutes')}
              hint={t('settings.typicalServiceHint')}
              required
            />
            <Field
              label={t('settings.maxSize')}
              optional
              type="number"
              min={1}
              value={form.maxSize ?? ''}
              onChange={update('maxSize')}
              hint={t('settings.maxSizeHint')}
            />
          </div>
        </Card>
        </section>

        <section id="no-shows" className="scroll-mt-24">
        <Card>
          <CardHeader
            title={t('settings.noShowTitle')}
            description={t('settings.noShowHint')}
          />
          <div className="space-y-4">
            <Field
              label={t('settings.gracePeriod')}
              type="number"
              min={0}
              value={form.gracePeriodSeconds ?? ''}
              onChange={update('gracePeriodSeconds')}
              hint={t('settings.gracePeriodHint')}
              required
            />
            <SelectField
              label={t('settings.thenWhat')}
              value={policy}
              onChange={(event) => {
                setPolicy(event.target.value as NoShowPolicy)
                setSaved(false)
                setDirty(true)
              }}
              hint={policyHelp(t)[policy]}
            >
              <option value="KEEP_POSITION">{t('settings.policyKeep')}</option>
              <option value="MOVE_BACK">{t('settings.policyMoveBack')}</option>
              <option value="MOVE_TO_END">{t('settings.policyMoveEnd')}</option>
              <option value="REMOVE">{t('settings.policyRemove')}</option>
            </SelectField>
            {policy === 'MOVE_BACK' ? (
              <Field
                label={t('settings.placesBack')}
                type="number"
                min={1}
                value={form.moveBackPositions ?? ''}
                onChange={update('moveBackPositions')}
                required
              />
            ) : null}
          </div>
        </Card>
        </section>

        <section id="notifications" className="scroll-mt-24">
        <Card>
          <CardHeader
            title={t('settings.notifications')}
            description={t('settings.notificationsHint')}
          />
          {/*
            Subgrid, so the two inputs sit on the same line whatever the labels say. Side by side
            they are separate grid items, so a label that wraps to two lines pushes its own input
            down and the pair reads as broken. Copy length is not something to rely on here: these
            strings are translated, and the English label is longer than the Spanish one.
          */}
          <div className="grid gap-4 sm:grid-cols-2 sm:grid-rows-[auto_auto_auto] sm:gap-y-0">
            <Field
              className="sm:row-span-3 sm:grid sm:grid-rows-subgrid"
              label={t('settings.notifyPosition')}
              optional
              type="number"
              min={1}
              value={form.notifyAtPosition ?? ''}
              onChange={update('notifyAtPosition')}
              hint={t('settings.notifyPositionHint')}
            />
            <Field
              className="sm:row-span-3 sm:grid sm:grid-rows-subgrid"
              label={t('settings.notifyMinutes')}
              optional
              type="number"
              min={1}
              value={form.notifyAtMinutes ?? ''}
              onChange={update('notifyAtMinutes')}
              hint={t('settings.notifyMinutesHint')}
            />
          </div>
        </Card>
        </section>

        {error ? <Alert kind="error">{error}</Alert> : null}
        {saved ? <Alert kind="success">{t('settings.saved')}</Alert> : null}

        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void save()} loading={saving} disabled={!isOwner}>
            {t('settings.save')}
          </Button>
          <ButtonLink href={`/panel/queue?id=${queue.id}`} variant="ghost">
            {t('common.cancel')}
          </ButtonLink>
          {dirty ? <span className="text-sm text-warn">{t('settings.needsSaving')}</span> : null}
        </div>
      </div>

      {isOwner ? (
        <Card className="border-danger/25">
          <CardHeader
            title={t('settings.deleteTitle')}
            description={t('settings.deleteHint')}
          />
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            {t('settings.delete')}
          </Button>
        </Card>
      ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t('settings.confirmDeleteTitle', { name: queue.name })}
        description={t('settings.confirmDeleteBody')}
        confirmLabel={t('settings.delete')}
        destructive
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
      <ConfirmDialog
        open={laneToDelete !== null}
        title={laneToDelete ? t('lanes.deleteNamed', { name: laneToDelete.name }) : t('lanes.confirmDeleteTitle')}
        description={t('lanes.confirmDeleteBody')}
        confirmLabel={t('lanes.confirmDelete')}
        destructive
        onConfirm={() => {
          if (laneToDelete) void deleteLane(laneToDelete)
          setLaneToDelete(null)
        }}
        onCancel={() => setLaneToDelete(null)}
      />
    </div>
  )
}
