import { beforeAll, describe, expect, it } from 'vitest'
import type { NotificationRecord } from '../../src/domain/types.js'
import type { Fixture } from './support.js'
import { fixture } from './support.js'

let f: Fixture

beforeAll(async () => {
  f = await fixture()
})

describe('DirectoryStore contra DynamoDB Local', () => {
  it('crear un establecimiento deja a su creador como dueño, visible desde los dos lados', async () => {
    await f.directory.createEstablishment(
      { id: 'est-a', name: 'Café', timezone: 'America/Argentina/Buenos_Aires', createdAt: '2026-03-02T15:00:00.000Z' },
      'owner-sub',
    )
    expect(await f.directory.establishment('est-a')).toMatchObject({ name: 'Café' })
    expect(await f.directory.membership('owner-sub', 'est-a')).toMatchObject({ role: 'OWNER' })
    expect((await f.directory.membershipsOf('owner-sub')).map((m) => m.establishmentId)).toEqual(['est-a'])
    expect((await f.directory.membersOf('est-a')).map((m) => m.userId)).toEqual(['owner-sub'])
  })

  it('la membresía se revisa en cada request: sacar a alguien tiene efecto inmediato', async () => {
    await f.directory.putMembership({ userId: 'staff-sub', establishmentId: 'est-a', role: 'STAFF', createdAt: 'x' })
    await expect(f.directory.requireMember('staff-sub', 'est-a')).resolves.toMatchObject({ role: 'STAFF' })
    await expect(f.directory.requireMember('staff-sub', 'est-a', 'OWNER')).rejects.toMatchObject({
      code: 'OWNER_REQUIRED',
      status: 403,
    })
    await f.directory.removeMembership('staff-sub', 'est-a')
    await expect(f.directory.requireMember('staff-sub', 'est-a')).rejects.toMatchObject({ code: 'NOT_A_MEMBER' })
  })

  it('un aviso se reserva una sola vez por ciclo, salvo que el intento anterior haya fallado', async () => {
    const record: NotificationRecord = {
      entryId: 'entry-1',
      type: 'YOUR_TURN',
      cycle: 0,
      status: 'PENDING',
      channel: 'EMAIL',
      destination: 'ana@example.com',
      attempts: 0,
      createdAt: '2026-03-02T15:00:00.000Z',
      sentAt: null,
      failureReason: null,
    }
    expect(await f.directory.claimNotification(record)).toBe(true)
    // Un reintento de SQS mientras el primero sigue pendiente no lo vuelve a tomar.
    expect(await f.directory.claimNotification(record)).toBe(false)

    await f.directory.markNotification('entry-1', 'YOUR_TURN', 0, { status: 'FAILED', reason: 'smtp caído' })
    expect(await f.directory.claimNotification(record)).toBe(true)
    await f.directory.markNotification('entry-1', 'YOUR_TURN', 0, { status: 'SENT', at: '2026-03-02T15:01:00.000Z' })
    expect(await f.directory.claimNotification(record)).toBe(false)

    // Un ciclo nuevo (volvió a la fila y la llaman otra vez) sí es un aviso nuevo.
    expect(await f.directory.claimNotification({ ...record, cycle: 1 })).toBe(true)

    const history = await f.directory.notificationsOf('entry-1')
    expect(history.find((notice) => notice.cycle === 0)).toMatchObject({ status: 'SENT', failureReason: null })
  })

  it('el límite por IP corta en el request número N+1 del mismo minuto', async () => {
    const now = new Date('2026-03-02T15:00:10Z')
    const results: boolean[] = []
    for (let i = 0; i < 4; i++) results.push(await f.directory.allowRequest('203.0.113.7', 3, now))
    expect(results).toEqual([true, true, true, false])
    expect(await f.directory.allowRequest('203.0.113.7', 3, new Date('2026-03-02T15:01:00Z'))).toBe(true)
    expect(await f.directory.allowRequest('198.51.100.1', 3, now)).toBe(true)
  })
})
