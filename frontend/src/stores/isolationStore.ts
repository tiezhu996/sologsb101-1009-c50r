/**
 * 隔离作业票状态（Zustand）
 * 一张票两套状态：现场组维护测点读数与处置措施；值班室维护隔离范围与复检放行。
 * 两套字段分别更新、各自记录侧更新时间，回传对账时按归属决定采纳方。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, type IsolationTicketRow } from '@/utils/db'
import {
  FIELD_ISOLATION_FLOW,
  DUTY_ISOLATION_FLOW,
  latestReading,
  type DutyIsolationState,
  type DutyTicketPatch,
  type FieldIsolationState,
  type FieldTicketPatch,
  type IsolationTicket,
  type IsolationTicketDraft,
  type MeasurePointReading
} from '@/types/isolation'

interface IsolationState_ {
  tickets: IsolationTicket[]
  ready: boolean
  createTicket: (draft: IsolationTicketDraft) => Promise<IsolationTicket>
  patchField: (id: string, patch: FieldTicketPatch) => Promise<void>
  patchDuty: (id: string, patch: DutyTicketPatch) => Promise<void>
  addMeasurePoint: (id: string, pointName: string, valuePpm: number, measuredAt: string) => Promise<void>
  advanceField: (id: string) => Promise<FieldIsolationState | null>
  advanceDuty: (id: string, approver?: string) => Promise<DutyIsolationState | null>
  approveRetest: (id: string, approver: string) => Promise<void>
  removeTicket: (id: string) => Promise<void>
  filteredTickets: (stationId: string, sideState: { field?: FieldIsolationState; duty?: DutyIsolationState }) => IsolationTicket[]
  latestPpm: (ticket: IsolationTicket) => number
}

function emptyTicket(draft: IsolationTicketDraft): IsolationTicketRow {
  const now = Date.now()
  return {
    id: createId('iso'),
    ticketNo: draft.ticketNo.trim(),
    deviceId: draft.deviceId,
    stationId: draft.stationId,
    leakId: draft.leakId ?? '',
    fieldState: '隔离待测',
    measurePointReadings: [],
    measure: '',
    fieldOperator: '',
    measuredAt: '',
    fieldUpdatedAt: now,
    dutyState: '待划定',
    isolationScope: '',
    isolatedBy: '',
    isolatedAt: '',
    retestApproved: false,
    retestApprover: '',
    retestApprovedAt: '',
    dutyUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  }
}

export const useIsolationStore = create<IsolationState_>((_set, get) => ({
  tickets: [],
  ready: false,

  async createTicket(draft) {
    const device = await db.devices.get(draft.deviceId)
    const row = emptyTicket({
      ...draft,
      ticketNo: draft.ticketNo || `ISO-${Date.now().toString(36)}`,
      stationId: draft.stationId || (device ? device.stationId : '')
    })
    await db.isolationTickets.put(row)
    return row
  },

  async patchField(id, patch) {
    const next: Partial<IsolationTicketRow> = { ...patch, fieldUpdatedAt: Date.now(), updatedAt: Date.now() }
    if (patch.measure !== undefined) next.measure = patch.measure.trim()
    if (patch.fieldOperator !== undefined) next.fieldOperator = patch.fieldOperator.trim()
    if (patch.measurePointReadings) {
      next.measuredAt = latestReading(patch.measurePointReadings)?.measuredAt ?? ''
    }
    await db.isolationTickets.update(id, next)
  },

  async patchDuty(id, patch) {
    const next: Partial<IsolationTicketRow> = { ...patch, dutyUpdatedAt: Date.now(), updatedAt: Date.now() }
    if (patch.isolationScope !== undefined) next.isolationScope = patch.isolationScope.trim()
    if (patch.isolatedBy !== undefined) next.isolatedBy = patch.isolatedBy.trim()
    if (patch.retestApprover !== undefined) next.retestApprover = patch.retestApprover.trim()
    await db.isolationTickets.update(id, next)
  },

  async addMeasurePoint(id, pointName, valuePpm, measuredAt) {
    const ticket = get().tickets.find((item) => item.id === id)
    if (!ticket) return
    const reading: MeasurePointReading = { id: createId('mr'), pointName: pointName.trim(), valuePpm: Number(valuePpm) || 0, measuredAt }
    const readings = [...ticket.measurePointReadings, reading]
    await get().patchField(id, { measurePointReadings: readings })
  },

  async advanceField(id) {
    const ticket = get().tickets.find((item) => item.id === id)
    if (!ticket) return null
    const next = FIELD_ISOLATION_FLOW[ticket.fieldState]
    if (!next) return null
    await get().patchField(id, { fieldState: next })
    return next
  },

  async advanceDuty(id, approver) {
    const ticket = get().tickets.find((item) => item.id === id)
    if (!ticket) return null
    const next = DUTY_ISOLATION_FLOW[ticket.dutyState]
    if (!next) return null
    const patch: DutyTicketPatch = { dutyState: next }
    if (next === '已隔离') {
      patch.isolatedAt = ticket.isolatedAt || new Date().toISOString().slice(0, 16).replace('T', ' ')
      if (approver) patch.isolatedBy = approver
    }
    await get().patchDuty(id, patch)
    return next
  },

  async approveRetest(id, approver) {
    await get().patchDuty(id, {
      dutyState: '已放行',
      retestApproved: true,
      retestApprover: approver.trim() || '值班长',
      retestApprovedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
    })
  },

  async removeTicket(id) {
    await db.isolationTickets.delete(id)
  },

  filteredTickets(stationId, sideState) {
    return get()
      .tickets.filter((ticket) => {
        if (stationId && ticket.stationId !== stationId) return false
        if (sideState.field && ticket.fieldState !== sideState.field) return false
        if (sideState.duty && ticket.dutyState !== sideState.duty) return false
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  },

  latestPpm(ticket) {
    return latestReading(ticket.measurePointReadings)?.valuePpm ?? 0
  }
}))

liveQuery(async () => (await db.isolationTickets.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)).subscribe({
  next: (rows) => useIsolationStore.setState({ tickets: rows, ready: true }),
  error: () => useIsolationStore.setState({ ready: true })
})
