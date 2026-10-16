// Cada movimiento de un cliente por la fila.
//
// Todas las operaciones empiezan venciendo las gracias que ya pasaron, igual que la versión Java:
// así nunca se decide sobre un llamado que el reloj ya invalidó. La serialización por cola, que antes
// daba el `SELECT … FOR UPDATE`, la da ahora la persistencia con la versión de la cola.

import { conflict, notFound, validation } from './errors.js'
import { recordServiceTime } from './estimation.js'
import { allocateEndKey, applyNoShow, expireDue } from './grace.js'
import { ensureLaneCapacity, selectLane } from './lanes.js'
import { rotation, select } from './selector.js'
import type { Actor, Session } from './state.js'
import { CUSTOMER } from './state.js'
import type { Entry, EntryStatus, SupportedLocale } from './types.js'
import { isActive, isTerminal } from './types.js'

export interface JoinCommand {
  name: string | null | undefined
  email?: string | null | undefined
  phone?: string | null | undefined
  partySize?: number | null | undefined
  locale?: SupportedLocale | null | undefined
}

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim()
  return text ? text : null
}

/** Funcionalidad 1: un cliente escanea el QR y toma un lugar. */
export function join(session: Session, command: JoinCommand): Entry {
  expireDue(session)
  const queue = session.queue

  const name = trimmed(command.name)
  if (!name) throw validation('CUSTOMER_NAME_REQUIRED', 'A name is required')
  const email = trimmed(command.email)?.toLowerCase() ?? null
  const phone = trimmed(command.phone)
  if (!email && !phone) {
    throw validation(
      'CONTACT_REQUIRED',
      'An email address or a phone number is required so we can send you your ticket link',
    )
  }
  if (queue.status !== 'OPEN' || queue.archivedAt !== null) {
    throw conflict(
      'QUEUE_NOT_ACCEPTING',
      `This queue is ${queue.archivedAt ? 'archived' : queue.status.toLowerCase()} and is not taking new customers`,
    )
  }

  // Una farmacia o un banco no tienen noción de grupo: una persona es el valor honesto por defecto.
  const partySize = command.partySize ?? 1
  if (!Number.isInteger(partySize) || partySize < 1) {
    throw validation('INVALID_PARTY_SIZE', 'partySize must be a positive integer')
  }
  const lane = selectLane(session.state.lanes, partySize)
  ensureLaneCapacity(lane, session.state.entries, partySize)

  const active = session.state.entries.filter((entry) => isActive(entry.status)).length
  if (queue.maxSize !== null && active + 1 > queue.maxSize) {
    throw conflict('QUEUE_FULL', 'This queue has reached its maximum size')
  }

  const entry: Entry = {
    id: session.newId(),
    queueId: queue.id,
    laneId: lane.id,
    ticketToken: session.newId(),
    ticketNumber: queue.nextTicketNumber,
    customerName: name,
    customerEmail: email,
    customerPhone: phone,
    partySize,
    locale: command.locale ?? 'en',
    status: 'WAITING',
    orderKey: allocateEndKey(session),
    notificationCycle: 0,
    noShowCount: 0,
    joinedAt: session.nowIso,
    calledAt: null,
    servingStartedAt: null,
    finishedAt: null,
    graceExpiresAt: null,
  }
  queue.nextTicketNumber += 1
  session.touchQueue()
  session.addEntry(entry)
  session.record('ENTRY_JOINED', CUSTOMER, entry, { ticketNumber: entry.ticketNumber, laneId: lane.id })
  return entry
}

/** Funcionalidad 5: el cliente deja su lugar. */
export function leave(session: Session, entryId: string): Entry {
  expireDue(session)
  const entry = requireEntry(session, entryId)
  if (isTerminal(entry.status)) {
    throw conflict('ENTRY_NOT_ACTIVE', `This ticket is already ${entry.status.toLowerCase()}`)
  }
  release(session, entry, CUSTOMER)
  return entry
}

/** Funcionalidad 4: llamar a quien sigue según la estrategia de la cola, o al primero de un carril. */
export function callNext(session: Session, actor: Actor, laneId?: string): Entry {
  expireDue(session)
  requireOperable(session)
  const queue = session.queue

  let waiting = session.waiting()
  if (laneId !== undefined) waiting = waiting.filter((entry) => entry.laneId === laneId)
  if (waiting.length === 0) {
    throw conflict('QUEUE_EMPTY', laneId ? 'There is nobody waiting in this lane' : 'There is nobody waiting in this queue')
  }

  let entry: Entry
  if (laneId !== undefined) {
    entry = waiting[0] as Entry
  } else {
    const selection = select(
      queue.callStrategy,
      session.state.lanes,
      rotation(session.state.lanes),
      waiting,
      queue.roundRobinPosition,
    )
    entry = selection.entry
    if (queue.callStrategy === 'ROUND_ROBIN' && selection.nextRoundRobinPosition !== queue.roundRobinPosition) {
      queue.roundRobinPosition = selection.nextRoundRobinPosition
      session.touchQueue()
    }
  }
  doCall(session, entry, actor)
  return entry
}

/** Llama a alguien puntual: así el staff se saltea a quien no está. */
export function call(session: Session, entryId: string, actor: Actor): Entry {
  expireDue(session)
  requireOperable(session)
  const entry = requireEntry(session, entryId)
  doCall(session, entry, actor)
  return entry
}

/** El cliente se presentó y lo están atendiendo. */
export function startServing(session: Session, entryId: string, actor: Actor): Entry {
  expireDue(session)
  const entry = requireEntry(session, entryId)
  requireStatus(entry, 'CALLED')
  entry.status = 'SERVING'
  entry.servingStartedAt = session.nowIso
  entry.graceExpiresAt = null
  session.touchEntry(entry)
  session.record('ENTRY_SERVING_STARTED', actor, entry)
  return entry
}

/** Terminó el servicio. Es la medición que alimenta todas las esperas futuras. */
export function markServed(session: Session, entryId: string, actor: Actor): Entry {
  expireDue(session)
  const entry = requireEntry(session, entryId)
  requireStatus(entry, 'CALLED', 'SERVING')

  // Si el staff pasó directo de "llamado" a "listo", el llamado cuenta como inicio, así la duración
  // igual entra en el promedio.
  entry.servingStartedAt ??= entry.calledAt ?? session.nowIso
  entry.status = 'SERVED'
  entry.finishedAt = session.nowIso
  entry.graceExpiresAt = null

  const seconds = (session.now.getTime() - Date.parse(entry.servingStartedAt)) / 1000
  session.queue.recentServiceSeconds = recordServiceTime(session.queue.recentServiceSeconds, seconds)
  session.touchQueue()
  session.touchEntry(entry)
  session.record('ENTRY_SERVED', actor, entry, { serviceSeconds: Math.round(seconds) })
  return entry
}

/** El staff declara ausente al cliente sin esperar a que venza la gracia. */
export function markNoShow(session: Session, entryId: string, actor: Actor): Entry {
  expireDue(session)
  const entry = requireEntry(session, entryId)
  requireStatus(entry, 'CALLED')
  applyNoShow(session, entry, actor)
  return entry
}

/** El staff saca a alguien de la fila. */
export function cancel(session: Session, entryId: string, actor: Actor): Entry {
  expireDue(session)
  const entry = requireEntry(session, entryId)
  if (isTerminal(entry.status)) {
    throw conflict('ENTRY_NOT_ACTIVE', `This entry is already ${entry.status.toLowerCase()}`)
  }
  release(session, entry, actor)
  return entry
}

/**
 * Devuelve una entrada a la fila. Deshacer un llamado conserva el lugar; traer de vuelta a alguien
 * que ya se había ido o estaba ausente lo pone al final, porque su clave vieja ya no significa nada.
 */
export function requeue(session: Session, entryId: string, actor: Actor): Entry {
  expireDue(session)
  requireOperable(session)
  const entry = requireEntry(session, entryId)
  if (entry.status === 'WAITING') throw conflict('ALREADY_WAITING', 'This entry is already waiting')

  const wasTerminal = isTerminal(entry.status)
  entry.status = 'WAITING'
  entry.calledAt = null
  entry.servingStartedAt = null
  entry.finishedAt = null
  entry.graceExpiresAt = null
  entry.notificationCycle += 1
  if (wasTerminal) entry.orderKey = allocateEndKey(session)
  session.touchEntry(entry)
  session.record('ENTRY_REQUEUED', actor, entry, { placement: wasTerminal ? 'END' : 'KEEP_POSITION' })
  return entry
}

/** El único punto de entrada detrás de `PUT /entries/{id}/status`. */
export function transition(session: Session, entryId: string, target: EntryStatus, actor: Actor): Entry {
  switch (target) {
    case 'CALLED':
      return call(session, entryId, actor)
    case 'SERVING':
      return startServing(session, entryId, actor)
    case 'SERVED':
      return markServed(session, entryId, actor)
    case 'NO_SHOW':
      return markNoShow(session, entryId, actor)
    case 'LEFT':
      return cancel(session, entryId, actor)
    case 'WAITING':
      return requeue(session, entryId, actor)
  }
}

/**
 * Cuántas entradas libera `λ lifecycle` por transacción. Cada una escribe cuatro ítems (borrar su SK
 * viejo, escribir el nuevo, actualizar su referencia y su evento) y la cola uno más: 24 × 4 + 1 = 97,
 * por debajo de los 100 de una transacción de DynamoDB.
 */
export const RELEASE_BATCH_SIZE = 24

/**
 * Libera hasta `limit` entradas activas de una cola cerrada. Lo usa `λ lifecycle` en lotes, para que
 * ninguna transacción pase el límite de 100 ítems de DynamoDB.
 *
 * @returns cuántas liberó; cero significa que ya no queda nadie
 */
export function releaseBatch(session: Session, limit: number, actor: Actor): number {
  if (session.queue.status !== 'CLOSED') return 0
  const batch = [...session.inService(), ...session.waiting()].slice(0, Math.max(0, limit))
  for (const entry of batch) release(session, entry, actor, { reason: 'QUEUE_CLOSED' })
  return batch.length
}

// ----------------------------------------------------------------------------- internos

function doCall(session: Session, entry: Entry, actor: Actor): void {
  requireStatus(entry, 'WAITING')
  const grace = session.queue.gracePeriodSeconds
  entry.status = 'CALLED'
  entry.calledAt = session.nowIso
  // Una gracia de cero significa que el establecimiento no quiere ausencias automáticas.
  entry.graceExpiresAt = grace > 0 ? new Date(session.now.getTime() + grace * 1000).toISOString() : null
  session.touchEntry(entry)
  session.record('ENTRY_CALLED', actor, entry, {
    graceSeconds: grace,
    graceExpiresAt: entry.graceExpiresAt,
  })
}

function release(session: Session, entry: Entry, actor: Actor, detail: Record<string, string> = {}): void {
  entry.status = 'LEFT'
  entry.finishedAt = session.nowIso
  entry.graceExpiresAt = null
  session.touchEntry(entry)
  session.record('ENTRY_LEFT', actor, entry, detail)
}

function requireEntry(session: Session, entryId: string): Entry {
  const entry = session.findEntry(entryId)
  if (!entry) throw notFound('ENTRY_NOT_FOUND', `Entry ${entryId} was not found`)
  return entry
}

function requireOperable(session: Session): void {
  if (session.queue.status === 'CLOSED' || session.queue.archivedAt !== null) {
    throw conflict('QUEUE_CLOSED', 'This queue is closed')
  }
}

function requireStatus(entry: Entry, ...allowed: EntryStatus[]): void {
  if (!allowed.includes(entry.status)) {
    throw conflict(
      'INVALID_TRANSITION',
      `An entry in status ${entry.status} cannot make this transition (expected one of ${allowed.join(', ')})`,
    )
  }
}
