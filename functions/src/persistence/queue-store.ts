// Leer una cola y escribir sus cambios con control optimista (arquitectura-serverless.md §6.1).
//
// Hoy cada mutación tomaba `SELECT … FOR UPDATE` sobre la fila de la cola. DynamoDB no tiene locks:
// el equivalente es leer `META.version`, decidir en memoria y escribir todo en una transacción que
// solo pasa si la versión sigue siendo la misma. Si otro escritor ganó, se relee y se vuelve a
// decidir. Las transacciones de DynamoDB son serializables entre sí, así que dos personas del staff
// que llaman a la vez producen exactamente un llamado cada una, sobre personas distintas.

import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import { randomUUID } from 'node:crypto'
import { conflict, notFound } from '../domain/errors.js'
import { expireDue, hasDueGrace } from '../domain/grace.js'
import type { QueueState } from '../domain/state.js'
import { Session } from '../domain/state.js'
import type { Entry, Lane, Queue } from '../domain/types.js'
import type { TableConfig } from './client.js'
import * as items from './items.js'
import type { Item } from './items.js'
import * as keys from './keys.js'

/** El máximo de una transacción de DynamoDB. */
export const MAX_TRANSACTION_ITEMS = 100
export const DEFAULT_MAX_ATTEMPTS = 5

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

export interface MutateOptions {
  /** Entradas terminadas que la operación necesita leer (por ejemplo, para volver a ponerlas). */
  entryIds?: readonly string[]
  maxAttempts?: number
  now?: () => Date
  newId?: () => string
  /** Solo para tests: corre entre la lectura y la escritura de cada intento. */
  afterLoad?: (attempt: number) => Promise<void>
}

export interface MutationResult<R> {
  result: R
  state: QueueState
  session: Session
  /** Cuántas veces hubo que releer por un conflicto de versión. */
  retries: number
}

/** La versión de otra escritura ganó: hay que releer. */
class VersionConflict extends Error {}

export class QueueStore {
  constructor(private readonly table: TableConfig) {}

  /**
   * La cola con sus carriles y sus entradas activas, con lecturas fuertemente consistentes: después
   * de escribir, quien lee ve lo que se escribió (un cliente que se acaba de unir se encuentra).
   */
  async load(queueId: string, entryIds: readonly string[] = []): Promise<QueueState> {
    const pk = keys.queuePk(queueId)
    const [config, inService, waiting] = await Promise.all([
      // `LANE#…` < `META` en orden de bytes: un solo rango trae los carriles y la configuración.
      this.queryAll({
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': pk, ':from': 'LANE#', ':to': keys.QUEUE_META_SK },
      }),
      this.queryPrefix(pk, keys.IN_SERVICE_PREFIX),
      this.queryPrefix(pk, keys.WAITING_PREFIX),
    ])

    const metaItem = config.find((item) => item['SK'] === keys.QUEUE_META_SK)
    if (!metaItem) throw notFound('QUEUE_NOT_FOUND', `Queue ${queueId} was not found`)

    const entries = [...inService, ...waiting].map((item) => items.strip<Entry>(item))
    const missing = entryIds.filter((id) => !entries.some((entry) => entry.id === id))
    for (const entry of await Promise.all(missing.map((id) => this.loadEntryById(id)))) {
      if (entry && entry.queueId === queueId) entries.push(entry)
    }

    return {
      queue: items.strip<Queue>(metaItem),
      lanes: config.filter((item) => item['kind'] === 'LANE').map((item) => items.strip<Lane>(item)),
      entries,
    }
  }

  /**
   * Lee la cola para responder una consulta. Si encuentra una gracia vencida la aplica antes, así
   * nadie ve un llamado que el reloj ya invalidó; si no, no escribe nada.
   */
  async read(queueId: string, options: Pick<MutateOptions, 'entryIds' | 'now'> = {}): Promise<QueueState> {
    const now = options.now ?? (() => new Date())
    const state = await this.load(queueId, options.entryIds)
    if (!hasDueGrace(state.entries, now())) return state
    // Si otro disparador ya la aplicó, el reintento relee y no encuentra nada: no es un error.
    const { state: fresh } = await this.mutate(queueId, (session) => expireDue(session), options)
    return fresh
  }

  /**
   * Corre una operación del dominio sobre la cola y escribe sus cambios en una sola transacción.
   * La operación tiene que ser pura sobre la sesión: ante un conflicto se vuelve a correr desde cero.
   */
  async mutate<R>(queueId: string, operation: (session: Session) => R, options: MutateOptions = {}): Promise<MutationResult<R>> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const now = options.now ?? (() => new Date())
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const state = await this.load(queueId, options.entryIds)
      await options.afterLoad?.(attempt)
      const session = new Session(state, now(), options.newId)
      const result = operation(session)
      try {
        await this.commit(session)
        return { result, state: session.state, session, retries: attempt }
      } catch (error) {
        if (!(error instanceof VersionConflict)) throw error
        await backoff(attempt)
      }
    }
    throw conflict('CONCURRENT_MODIFICATION', 'The queue changed while this operation ran. Please try again.')
  }

  /** Crea una cola nueva: su configuración, sus carriles, la fila del listado y el evento. */
  async create(state: QueueState, record: (session: Session) => void, now = new Date()): Promise<Session> {
    const session = new Session(state, now)
    record(session)
    session.touchQueue()
    for (const lane of state.lanes) session.touchLane(lane)
    await this.commit(session, { creating: true })
    return session
  }

  /**
   * Arma la transacción con todo lo que la sesión tocó, condicionada a la versión leída.
   *
   * Cada entrada que cambió de estado se mueve: se borra su SK viejo y se escribe el nuevo, y se
   * actualiza su referencia `ENTRY#…/REF` para que se la pueda encontrar por id.
   */
  async commit(session: Session, options: { creating?: boolean } = {}): Promise<void> {
    if (!session.hasChanges) return
    const { tableName } = this.table
    const queue = session.state.queue
    const readVersion = queue.version
    const version = options.creating ? 0 : readVersion + 1
    const now = session.now

    const writes: TransactItem[] = []
    const put = (item: Item, condition?: string, values?: Record<string, unknown>): void => {
      writes.push({
        Put: {
          TableName: tableName,
          Item: item,
          ...(condition ? { ConditionExpression: condition } : {}),
          ...(values ? { ExpressionAttributeValues: values } : {}),
        },
      })
    }

    // La versión es lo que serializa a los escritores de una cola. Va primera: si una transacción
    // se cancela, su motivo en la posición 0 dice si fue por esto.
    queue.version = version
    if (options.creating) put(items.queueItem(queue), 'attribute_not_exists(PK)')
    else put(items.queueItem(queue), 'version = :read', { ':read': readVersion })

    for (const entryId of session.touchedEntries) {
      const entry = session.findEntry(entryId)
      if (!entry) continue
      const before = session.original.get(entryId)
      const sk = keys.entrySk(entry)
      if (!before) {
        put(items.entryItem(entry), 'attribute_not_exists(PK)')
        put(items.ticketItem(entry), 'attribute_not_exists(PK)')
        put(items.entryRefItem(entry), 'attribute_not_exists(PK)')
        continue
      }
      const previousSk = keys.entrySk(before)
      if (previousSk !== sk) {
        writes.push({ Delete: { TableName: tableName, Key: { PK: keys.queuePk(entry.queueId), SK: previousSk } } })
        writes.push({
          Update: {
            TableName: tableName,
            Key: { PK: keys.entryPk(entry.id), SK: keys.ENTRY_REF_SK },
            UpdateExpression: 'SET sk = :sk',
            ExpressionAttributeValues: { ':sk': sk },
          },
        })
      }
      put(items.entryItem(entry))
    }

    for (const laneId of session.touchedLanes) {
      const lane = session.state.lanes.find((candidate) => candidate.id === laneId)
      if (lane) put(items.laneItem(lane))
    }

    // La fila del listado del establecimiento sigue al nombre y al estado de la cola, y solo se
    // reescribe cuando alguno de los dos cambió.
    const listed = session.originalQueue
    if (
      options.creating ||
      listed.name !== queue.name ||
      listed.status !== queue.status ||
      listed.archivedAt !== queue.archivedAt
    ) {
      put(items.establishmentQueueItem(queue))
    }

    session.events.forEach((event, index) => put(items.eventItem(event, version, index, now), 'attribute_not_exists(PK)'))

    if (writes.length > MAX_TRANSACTION_ITEMS) {
      queue.version = readVersion
      throw new RangeError(`La operación escribe ${writes.length} ítems; una transacción admite ${MAX_TRANSACTION_ITEMS}`)
    }

    try {
      await this.table.documents.send(
        new TransactWriteCommand({ TransactItems: writes, ClientRequestToken: randomUUID() }),
      )
    } catch (error) {
      queue.version = readVersion
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? []
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          if (options.creating) throw conflict('QUEUE_EXISTS', `Queue ${queue.id} already exists`)
          throw new VersionConflict()
        }
        // Otra transacción estaba tocando alguno de los mismos ítems en ese instante: es el mismo
        // caso que perder la versión, y se resuelve igual.
        if (reasons.some((reason) => reason.Code === 'TransactionConflict')) throw new VersionConflict()
      }
      throw error
    }
  }

  /** Una entrada por id, esté en el estado que esté. */
  async loadEntryById(entryId: string): Promise<Entry | null> {
    const ref = await this.get(keys.entryPk(entryId), keys.ENTRY_REF_SK)
    if (!ref) return null
    const item = await this.get(keys.queuePk(String(ref['queueId'])), String(ref['sk']))
    return item ? items.strip<Entry>(item) : null
  }

  /** La cola a la que pertenece una entrada. Es inmutable, así que no hace falta leer la entrada. */
  async queueIdOfEntry(entryId: string): Promise<string | null> {
    const ref = await this.get(keys.entryPk(entryId), keys.ENTRY_REF_SK)
    return ref ? String(ref['queueId']) : null
  }

  /** Resuelve el ticket token de un cliente a su cola y su entrada. */
  async resolveTicket(token: string): Promise<{ queueId: string; entryId: string } | null> {
    const ticket = await this.get(keys.ticketPk(token), keys.TICKET_SK)
    return ticket ? { queueId: String(ticket['queueId']), entryId: String(ticket['entryId']) } : null
  }

  /** Las entradas que terminaron en [from, to), para las métricas. */
  async finishedBetween(queueId: string, from: string, to: string): Promise<Entry[]> {
    const found = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': keys.queuePk(queueId), ':from': keys.finishedSk(from), ':to': keys.finishedSk(to) },
    })
    return found.map((item) => items.strip<Entry>(item)).filter((entry) => (entry.finishedAt ?? '') < to)
  }

  /** Los eventos de una cola, del más viejo al más nuevo. */
  async events(queueId: string): Promise<Item[]> {
    return this.queryAll({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.eventsPk(queueId) },
    })
  }

  private async get(pk: string, sk: string): Promise<Item | null> {
    const { Item } = await this.table.documents.send(
      new GetCommand({ TableName: this.table.tableName, Key: { PK: pk, SK: sk }, ConsistentRead: true }),
    )
    return Item ?? null
  }

  private queryPrefix(pk: string, prefix: string): Promise<Item[]> {
    return this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
    })
  }

  private async queryAll(input: { KeyConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> }) {
    const found: Item[] = []
    let start: Record<string, unknown> | undefined
    do {
      const page = await this.table.documents.send(
        new QueryCommand({ TableName: this.table.tableName, ConsistentRead: true, ExclusiveStartKey: start, ...input }),
      )
      found.push(...((page.Items ?? []) as Item[]))
      start = page.LastEvaluatedKey
    } while (start)
    return found
  }
}

/** Backoff exponencial con jitter completo: dos escritores que chocan no vuelven a chocar igual. */
function backoff(attempt: number): Promise<void> {
  const cap = Math.min(500, 20 * 2 ** attempt)
  return new Promise((resolve) => setTimeout(resolve, Math.random() * cap))
}
