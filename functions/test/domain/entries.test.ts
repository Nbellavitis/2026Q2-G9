import { describe, expect, it } from 'vitest'
import {
  call,
  callNext,
  cancel,
  join,
  leave,
  markNoShow,
  markServed,
  releaseBatch,
  requeue,
  startServing,
  transition,
} from '../../src/domain/entries.js'
import { DomainError } from '../../src/domain/errors.js'
import { expireDue } from '../../src/domain/grace.js'
import { changeStatus } from '../../src/domain/queues.js'
import { CUSTOMER, staff } from '../../src/domain/state.js'
import type { NoShowPolicy } from '../../src/domain/types.js'
import { NOW, entry, ids, lane, queueState, session } from './fixtures.js'

const STAFF = staff('user-1')
const IN_A_MINUTE = new Date(NOW.getTime() + 60_000).toISOString()

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return undefined
}

describe('join', () => {
  it('reparte números de ticket correlativos y pone a cada uno al final', () => {
    const s = session(queueState())
    const ana = join(s, { name: ' Ana ', email: 'ANA@example.com' })
    const bruno = join(s, { name: 'Bruno', phone: '+54 11 5555 5555' })
    expect([ana.ticketNumber, bruno.ticketNumber]).toEqual([1, 2])
    expect(ids(s.waiting())).toEqual([ana.id, bruno.id])
    expect(ana.customerName).toBe('Ana')
    expect(ana.customerEmail).toBe('ana@example.com')
    expect(s.events.map((event) => event.type)).toEqual(['ENTRY_JOINED', 'ENTRY_JOINED'])
  })

  it('exige nombre y algún canal de contacto', () => {
    const s = session(queueState())
    expect(codeOf(() => join(s, { name: '  ', email: 'a@b.c' }))).toBe('CUSTOMER_NAME_REQUIRED')
    expect(codeOf(() => join(s, { name: 'Ana' }))).toBe('CONTACT_REQUIRED')
  })

  it('no acepta gente en una cola pausada o cerrada', () => {
    expect(codeOf(() => join(session(queueState({ status: 'PAUSED' })), { name: 'A', email: 'a@b.c' }))).toBe(
      'QUEUE_NOT_ACCEPTING',
    )
    expect(codeOf(() => join(session(queueState({ status: 'CLOSED' })), { name: 'A', email: 'a@b.c' }))).toBe(
      'QUEUE_NOT_ACCEPTING',
    )
  })

  it('respeta el tamaño máximo de la cola', () => {
    const state = queueState({ maxSize: 2 })
    state.entries.push(entry('a', 1), entry('b', 2, { status: 'CALLED' }))
    expect(codeOf(() => join(session(state), { name: 'C', email: 'c@x.y' }))).toBe('QUEUE_FULL')
  })

  it('elige el carril más específico y respeta su capacidad', () => {
    const state = queueState()
    state.lanes.push(lane('big', { minPartySize: 5, maxSize: 6, capacityMode: 'PERSONS' }))
    state.entries.push(entry('party', 1, { laneId: 'big', partySize: 4 }))
    const s = session(state)
    expect(join(s, { name: 'Dos', email: 'd@x.y', partySize: 2 }).laneId).toBe('lane-default')
    expect(codeOf(() => join(s, { name: 'Cinco', email: 'c@x.y', partySize: 5 }))).toBe('LANE_FULL')
  })
})

describe('llamar', () => {
  it('llama al que más espera y le fija el vencimiento de la gracia', () => {
    const state = queueState({ gracePeriodSeconds: 120 })
    state.entries.push(entry('a', 1), entry('b', 2))
    const s = session(state)
    const called = callNext(s, STAFF)
    expect(called.id).toBe('a')
    expect(called.status).toBe('CALLED')
    expect(called.graceExpiresAt).toBe(new Date(NOW.getTime() + 120_000).toISOString())
    expect(s.events[0]).toMatchObject({ type: 'ENTRY_CALLED', entryId: 'a', actorType: 'STAFF', actorId: 'user-1' })
  })

  it('una gracia de cero no vence nunca', () => {
    const state = queueState({ gracePeriodSeconds: 0 })
    state.entries.push(entry('a', 1))
    expect(callNext(session(state), STAFF).graceExpiresAt).toBeNull()
  })

  it('con la fila vacía responde QUEUE_EMPTY', () => {
    expect(codeOf(() => callNext(session(queueState()), STAFF))).toBe('QUEUE_EMPTY')
  })

  it('una cola cerrada no se opera', () => {
    const state = queueState({ status: 'CLOSED' })
    state.entries.push(entry('a', 1))
    expect(codeOf(() => callNext(session(state), STAFF))).toBe('QUEUE_CLOSED')
  })

  it('el round robin guarda el cursor en la cola', () => {
    const state = queueState({ callStrategy: 'ROUND_ROBIN' })
    state.lanes.push(lane('z-second', { priority: 1, minPartySize: 5 }))
    state.entries.push(entry('a', 1), entry('b', 2), entry('big', 3, { laneId: 'z-second', partySize: 6 }))
    const s = session(state)
    expect(callNext(s, STAFF).id).toBe('a')
    expect(s.queue.roundRobinPosition).toBe(1)
    expect(callNext(s, STAFF).id).toBe('big')
  })

  it('las transiciones inválidas se rechazan', () => {
    const state = queueState()
    state.entries.push(entry('a', 1))
    const s = session(state)
    expect(codeOf(() => startServing(s, 'a', STAFF))).toBe('INVALID_TRANSITION')
    expect(codeOf(() => transition(s, 'nadie', 'CALLED', STAFF))).toBe('ENTRY_NOT_FOUND')
  })
})

describe('atender', () => {
  it('marcar atendido guarda la duración para las esperas futuras', () => {
    const state = queueState()
    const startedAt = new Date(NOW.getTime() - 4 * 60_000).toISOString()
    state.entries.push(entry('a', 1, { status: 'SERVING', calledAt: startedAt, servingStartedAt: startedAt }))
    const s = session(state)
    const served = markServed(s, 'a', STAFF)
    expect(served.status).toBe('SERVED')
    expect(served.finishedAt).toBe(NOW.toISOString())
    expect(s.queue.recentServiceSeconds).toEqual([240])
  })

  it('pasar directo de llamado a atendido cuenta desde el llamado', () => {
    const state = queueState()
    const calledAt = new Date(NOW.getTime() - 60_000).toISOString()
    state.entries.push(entry('a', 1, { status: 'CALLED', calledAt }))
    const s = session(state)
    markServed(s, 'a', STAFF)
    expect(s.queue.recentServiceSeconds).toEqual([60])
  })
})

describe('ausencias', () => {
  const calledState = (policy: NoShowPolicy, moveBack = 2) => {
    const state = queueState({ noShowPolicy: policy, moveBackPositions: moveBack })
    state.entries.push(
      entry('ana', 1, { status: 'CALLED', calledAt: NOW.toISOString(), graceExpiresAt: IN_A_MINUTE }),
      entry('bruno', 2),
      entry('carla', 3),
      entry('dario', 4),
    )
    return state
  }

  it('KEEP_POSITION la devuelve a su lugar', () => {
    const s = session(calledState('KEEP_POSITION'))
    markNoShow(s, 'ana', STAFF)
    expect(ids(s.waiting())).toEqual(['ana', 'bruno', 'carla', 'dario'])
  })

  it('MOVE_BACK la corre N lugares, como el ejemplo de architecture.md', () => {
    const s = session(calledState('MOVE_BACK', 2))
    markNoShow(s, 'ana', STAFF)
    expect(ids(s.waiting())).toEqual(['bruno', 'carla', 'ana', 'dario'])
    expect(s.events.at(-1)?.detail).toMatchObject({ policy: 'MOVE_BACK', newPosition: 3 })
  })

  it('MOVE_TO_END la manda al final', () => {
    const s = session(calledState('MOVE_TO_END'))
    markNoShow(s, 'ana', STAFF)
    expect(ids(s.waiting())).toEqual(['bruno', 'carla', 'dario', 'ana'])
  })

  it('REMOVE la saca de la fila', () => {
    const s = session(calledState('REMOVE'))
    const ana = markNoShow(s, 'ana', STAFF)
    expect(ana.status).toBe('NO_SHOW')
    expect(ana.finishedAt).toBe(NOW.toISOString())
    expect(ids(s.waiting())).toEqual(['bruno', 'carla', 'dario'])
  })

  it('dos MOVE_BACK al mismo lugar no repiten clave aunque el primero esté llamado', () => {
    // Bruno cae entre Dario y Eva, y después lo llaman: mientras no está en la fila conserva su
    // clave, porque si vuelve con "deshacer llamado" la reclama. Cuando Ana cae en el mismo lugar, el
    // punto medio de esos vecinos es justo la clave de Bruno. Si se la dieran, al deshacer el llamado
    // de Bruno las dos entradas tendrían el mismo SK y DynamoDB pisaría a una con la otra.
    const state = queueState({ noShowPolicy: 'MOVE_BACK', moveBackPositions: 2 })
    state.entries.push(
      entry('ana', 1, { status: 'CALLED', graceExpiresAt: IN_A_MINUTE }),
      entry('bruno', 2, { status: 'CALLED', graceExpiresAt: IN_A_MINUTE }),
      entry('carla', 3),
      entry('dario', 4),
      entry('eva', 5),
    )
    const s = session(state)
    markNoShow(s, 'bruno', STAFF)
    expect(ids(s.waiting())).toEqual(['carla', 'dario', 'bruno', 'eva'])
    const brunoKey = s.findEntry('bruno')?.orderKey

    call(s, 'bruno', STAFF)
    markNoShow(s, 'ana', STAFF)
    expect(ids(s.waiting())).toEqual(['carla', 'dario', 'ana', 'eva'])
    expect(s.findEntry('ana')?.orderKey).not.toBe(brunoKey)

    requeue(s, 'bruno', STAFF)
    const keys = s.waiting().map((candidate) => candidate.orderKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(ids(s.waiting())).toEqual(['carla', 'dario', 'ana', 'bruno', 'eva'])
  })

  it('volver a esperar abre un ciclo de avisos nuevo', () => {
    const s = session(calledState('MOVE_TO_END'))
    const ana = markNoShow(s, 'ana', STAFF)
    expect(ana.notificationCycle).toBe(1)
    expect(ana.noShowCount).toBe(1)
  })

  it('cualquier operación vence primero las gracias pasadas', () => {
    const s = session(calledState('MOVE_TO_END'), new Date(NOW.getTime() + 120_000))
    // La gracia de Ana ya pasó: llamar al siguiente tiene que verla de vuelta en la fila, al final.
    expect(callNext(s, STAFF).id).toBe('bruno')
    expect(s.events.map((event) => event.type)).toEqual(['ENTRY_NO_SHOW', 'ENTRY_CALLED'])
  })

  it('una gracia que no venció no se toca', () => {
    const state = queueState()
    state.entries.push(entry('a', 1, { status: 'CALLED', graceExpiresAt: new Date(NOW.getTime() + 1000).toISOString() }))
    expect(expireDue(session(state))).toBe(false)
  })
})

describe('salir y volver', () => {
  it('el cliente puede irse, pero no dos veces', () => {
    const state = queueState()
    state.entries.push(entry('a', 1))
    const s = session(state)
    expect(leave(s, 'a').status).toBe('LEFT')
    expect(codeOf(() => leave(s, 'a'))).toBe('ENTRY_NOT_ACTIVE')
    expect(s.events[0]).toMatchObject({ type: 'ENTRY_LEFT', actorType: CUSTOMER.type })
  })

  it('deshacer un llamado conserva el lugar; traer de vuelta a alguien que se fue lo pone al final', () => {
    const state = queueState()
    state.entries.push(entry('a', 1, { status: 'CALLED' }), entry('b', 2), entry('c', 3))
    const s = session(state)
    requeue(s, 'a', STAFF)
    expect(ids(s.waiting())).toEqual(['a', 'b', 'c'])
    cancel(s, 'a', STAFF)
    requeue(s, 'a', STAFF)
    expect(ids(s.waiting())).toEqual(['b', 'c', 'a'])
    expect(codeOf(() => requeue(s, 'a', STAFF))).toBe('ALREADY_WAITING')
  })
})

describe('cerrar una cola', () => {
  it('cerrar es inmediato y deja el evento para que lifecycle libere la fila', () => {
    const state = queueState()
    state.entries.push(entry('a', 1), entry('b', 2, { status: 'CALLED' }))
    const s = session(state)
    changeStatus(s, 'CLOSED', STAFF)
    expect(s.queue.status).toBe('CLOSED')
    expect(s.events.map((event) => event.type)).toEqual(['QUEUE_STATUS_CHANGED', 'QUEUE_CLOSED'])
    expect(codeOf(() => join(s, { name: 'X', email: 'x@y.z' }))).toBe('QUEUE_NOT_ACCEPTING')
  })

  it('libera en lotes, primero a los que estaban siendo atendidos', () => {
    const state = queueState({ status: 'CLOSED' })
    state.entries.push(entry('a', 1), entry('b', 2), entry('c', 3, { status: 'CALLED' }))
    const s = session(state)
    expect(releaseBatch(s, 2, STAFF)).toBe(2)
    expect(state.entries.filter((candidate) => candidate.status === 'LEFT').map((candidate) => candidate.id)).toEqual([
      'a',
      'c',
    ])
    expect(releaseBatch(s, 2, STAFF)).toBe(1)
    expect(releaseBatch(s, 2, STAFF)).toBe(0)
    expect(s.events.every((event) => event.detail['reason'] === 'QUEUE_CLOSED')).toBe(true)
  })

  it('una cola abierta no se libera', () => {
    const state = queueState()
    state.entries.push(entry('a', 1))
    expect(releaseBatch(session(state), 10, STAFF)).toBe(0)
  })
})
