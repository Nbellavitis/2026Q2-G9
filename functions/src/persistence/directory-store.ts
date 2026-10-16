// Todo lo que no es la fila: establecimientos, membresías, avisos y el límite por IP.

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { forbidden } from '../domain/errors.js'
import type { Establishment, Membership, MembershipRole, NotificationRecord, QueueStatus } from '../domain/types.js'
import type { TableConfig } from './client.js'
import * as items from './items.js'
import type { Item } from './items.js'
import * as keys from './keys.js'

/**
 * Cuánto puede quedar un aviso reservado sin enviarse antes de que otro intento lo retome. Tiene que
 * superar el timeout de `λ notifier` (30 s), para no retomar uno que todavía se está enviando.
 */
export const NOTIFICATION_LEASE_SECONDS = 120

export interface QueueListing {
  queueId: string
  name: string
  status: QueueStatus
  archivedAt: string | null
}

export class DirectoryStore {
  constructor(private readonly table: TableConfig) {}

  /** Crea un establecimiento y deja a quien lo creó como dueño, en una sola transacción. */
  async createEstablishment(establishment: Establishment, ownerId: string): Promise<Membership> {
    const membership: Membership = {
      userId: ownerId,
      establishmentId: establishment.id,
      role: 'OWNER',
      createdAt: establishment.createdAt,
    }
    const [byUser, byEstablishment] = items.membershipItems(membership)
    await this.table.documents.send(
      new TransactWriteCommand({
        TransactItems: [items.establishmentItem(establishment), byUser, byEstablishment].map((Item) => ({
          Put: { TableName: this.table.tableName, Item, ConditionExpression: 'attribute_not_exists(PK)' },
        })),
      }),
    )
    return membership
  }

  async establishment(establishmentId: string): Promise<Establishment | null> {
    const item = await this.get(keys.establishmentPk(establishmentId), keys.ESTABLISHMENT_META_SK)
    return item ? items.strip<Establishment>(item) : null
  }

  /** Alta o cambio de rol de un miembro. Las dos copias se escriben juntas. */
  async putMembership(membership: Membership): Promise<void> {
    await this.table.documents.send(
      new TransactWriteCommand({
        TransactItems: items.membershipItems(membership).map((Item) => ({ Put: { TableName: this.table.tableName, Item } })),
      }),
    )
  }

  async removeMembership(userId: string, establishmentId: string): Promise<void> {
    await this.table.documents.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table.tableName, Key: { PK: keys.userPk(userId), SK: keys.membershipSk(establishmentId) } } },
          { Delete: { TableName: this.table.tableName, Key: { PK: keys.establishmentPk(establishmentId), SK: keys.memberSk(userId) } } },
        ],
      }),
    )
  }

  /**
   * La membresía se lee en cada request, con lectura fuerte, y no viaja en el token: sacar a alguien
   * de un local tiene efecto en su próximo request, no en su próximo login.
   */
  async membership(userId: string, establishmentId: string): Promise<Membership | null> {
    const item = await this.get(keys.userPk(userId), keys.membershipSk(establishmentId))
    return item ? items.strip<Membership>(item) : null
  }

  /** Exige que el usuario sea miembro del local, y dueño si se pide. */
  async requireMember(userId: string, establishmentId: string, role?: MembershipRole): Promise<Membership> {
    const membership = await this.membership(userId, establishmentId)
    if (!membership) throw forbidden('NOT_A_MEMBER', 'You are not a member of this establishment')
    if (role === 'OWNER' && membership.role !== 'OWNER') {
      throw forbidden('OWNER_REQUIRED', 'Only an owner can do this')
    }
    return membership
  }

  async membershipsOf(userId: string): Promise<Membership[]> {
    return (await this.queryPrefix(keys.userPk(userId), 'EST#')).map((item) => items.strip<Membership>(item))
  }

  async membersOf(establishmentId: string): Promise<Membership[]> {
    return (await this.queryPrefix(keys.establishmentPk(establishmentId), 'MEMBER#')).map((item) => items.strip<Membership>(item))
  }

  async queuesOf(establishmentId: string): Promise<QueueListing[]> {
    return (await this.queryPrefix(keys.establishmentPk(establishmentId), 'QUEUE#')).map((item) => ({
      queueId: String(item['queueId']),
      name: String(item['name']),
      status: item['status'] as QueueStatus,
      archivedAt: (item['archivedAt'] as string | null) ?? null,
    }))
  }

  /**
   * Reserva un aviso antes de enviarlo (arquitectura-serverless.md §6.5). Pasa si nunca se intentó,
   * si el intento anterior falló, o si quedó PENDING más de `leaseSeconds`: eso significa que la
   * Lambda que lo reservó murió antes de enviarlo, y sin este caso el aviso no saldría nunca (el
   * mismo defecto que tenía `retryFailed` en la versión Java). Si ya se envió, devuelve false.
   */
  async claimNotification(record: NotificationRecord, now = new Date(), leaseSeconds = NOTIFICATION_LEASE_SECONDS): Promise<boolean> {
    try {
      await this.table.documents.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: {
            PK: keys.entryPk(record.entryId),
            SK: keys.notificationSk(record.type, record.cycle),
            kind: 'NOTIFICATION',
            ...record,
            claimedAt: now.toISOString(),
          },
          ConditionExpression:
            'attribute_not_exists(PK) OR #status = :failed OR (#status = :pending AND claimedAt < :staleBefore)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':failed': 'FAILED',
            ':pending': 'PENDING',
            ':staleBefore': new Date(now.getTime() - leaseSeconds * 1000).toISOString(),
          },
        }),
      )
      return true
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false
      throw error
    }
  }

  async markNotification(
    entryId: string,
    type: NotificationRecord['type'],
    cycle: number,
    outcome: { status: 'SENT'; at: string } | { status: 'FAILED'; reason: string },
  ): Promise<void> {
    await this.table.documents.send(
      new UpdateCommand({
        TableName: this.table.tableName,
        Key: { PK: keys.entryPk(entryId), SK: keys.notificationSk(type, cycle) },
        UpdateExpression:
          outcome.status === 'SENT'
            ? 'SET #status = :status, sentAt = :at, failureReason = :none ADD attempts :one'
            : 'SET #status = :status, failureReason = :reason ADD attempts :one',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues:
          outcome.status === 'SENT'
            ? { ':status': 'SENT', ':at': outcome.at, ':none': null, ':one': 1 }
            : { ':status': 'FAILED', ':reason': outcome.reason, ':one': 1 },
      }),
    )
  }

  async notificationsOf(entryId: string): Promise<NotificationRecord[]> {
    return (await this.queryPrefix(keys.entryPk(entryId), 'NOTIF#')).map((item) => items.strip<NotificationRecord>(item))
  }

  /**
   * Cuenta un request de esta IP en el minuto actual. Devuelve false si ya pasó el límite.
   * El ítem vence solo a los dos minutos.
   */
  async allowRequest(ip: string, limitPerMinute: number, now = new Date()): Promise<boolean> {
    const minute = now.toISOString().slice(0, 16)
    try {
      await this.table.documents.send(
        new UpdateCommand({
          TableName: this.table.tableName,
          Key: { PK: keys.ratePk(ip, minute), SK: keys.RATE_SK },
          UpdateExpression: 'ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)',
          ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':limit': limitPerMinute, ':ttl': keys.epochSeconds(now) + 120 },
        }),
      )
      return true
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false
      throw error
    }
  }

  private async get(pk: string, sk: string): Promise<Item | null> {
    const { Item } = await this.table.documents.send(
      new GetCommand({ TableName: this.table.tableName, Key: { PK: pk, SK: sk }, ConsistentRead: true }),
    )
    return Item ?? null
  }

  private async queryPrefix(pk: string, prefix: string): Promise<Item[]> {
    const found: Item[] = []
    let start: Record<string, unknown> | undefined
    do {
      const page = await this.table.documents.send(
        new QueryCommand({
          TableName: this.table.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      )
      found.push(...((page.Items ?? []) as Item[]))
      start = page.LastEvaluatedKey
    } while (start)
    return found
  }
}
