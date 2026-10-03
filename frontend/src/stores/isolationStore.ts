/**
 * 隔离作业票状态（Zustand）
 * 双轨：现场态（测漏读数、处置措施）/ 值班态（隔离范围、复检放行）。
 * 现场组与值班室各操作自己归属的字段，互不可见写权限。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, type IsolationRow } from '@/utils/db'
import {
  ISOLATION_DUTY_FLOW,
  ISOLATION_FIELD_FLOW,
  isTicketClosed,
  buildTicketNo,
  type IsolationDutyState,
  type IsolationFieldState,
  type IsolationTicket
} from '@/types/isolation'

/** 当前页面角色：现场组 / 值班室（夜间抢修各开一份页面） */
export type WorkbenchRole = 'field' | 'duty'

export interface FieldAdvanceParams {
  leakTestPpm?: number
  fieldMeasure?: string
  fieldHandler?: string
  leakTestTime?: string
}

export interface DutyAdvanceParams {
  isolationScope?: string
  retestPpm?: number
  dutyHandler?: string
}

interface IsolationState_ {
  tickets: IsolationTicket[]
  role: WorkbenchRole
  ready: boolean
  setRole: (role: WorkbenchRole) => void
  ticketOfLeak: (leakId: string) => IsolationTicket | undefined
  createTicket: (params: { leakId: string; deviceId: string; stationId: string }) => Promise<IsolationTicket>
  /** 现场推进：测漏中 → 已处置 → 待复检（写现场归属字段） */
  advanceField: (id: string, params: FieldAdvanceParams) => Promise<IsolationFieldState | null>
  /** 值班推进：待划定 → 已隔离 → 已放行（写值班归属字段；复检 ≤50ppm 才放行） */
  advanceDuty: (id: string, params: DutyAdvanceParams) => Promise<IsolationDutyState | null>
  updateTicket: (id: string, patch: Partial<IsolationTicket>) => Promise<void>
  removeTicket: (id: string) => Promise<void>
  resolveReview: (id: string, patch: Partial<IsolationTicket>) => Promise<void>
  closedCount: () => number
  pendingReviewCount: () => number
}

export const useIsolationStore = create<IsolationState_>((set, get) => ({
  tickets: [],
  role: 'field',
  ready: false,

  setRole(role) {
    set({ role })
  },

  ticketOfLeak(leakId) {
    return get().tickets.find((ticket) => ticket.leakId === leakId)
  },

  async createTicket(params) {
    const now = Date.now()
    const row: IsolationRow = {
      id: createId('iso'),
      leakId: params.leakId,
      deviceId: params.deviceId,
      stationId: params.stationId,
      ticketNo: buildTicketNo(now),
      fieldState: '测漏中',
      leakTestPpm: 0,
      fieldMeasure: '',
      fieldHandler: '',
      leakTestTime: '',
      dutyState: '待划定',
      isolationScope: '',
      retestPpm: 0,
      released: false,
      dutyHandler: '',
      releasedAt: '',
      importPackageId: '',
      dupOf: '',
      needsReview: false,
      createdAt: now,
      updatedAt: now
    }
    await db.isolationTickets.put(row)
    return row
  },

  async advanceField(id, params) {
    const ticket = get().tickets.find((item) => item.id === id)
    if (!ticket) return null
    const next = ISOLATION_FIELD_FLOW[ticket.fieldState]
    if (!next) return null
    const patch: Partial<IsolationRow> = { fieldState: next, updatedAt: Date.now() }
    if (params.leakTestPpm !== undefined) patch.leakTestPpm = Number(params.leakTestPpm) || 0
    if (params.fieldMeasure !== undefined) patch.fieldMeasure = params.fieldMeasure.trim()
    if (params.fieldHandler !== undefined) patch.fieldHandler = params.fieldHandler.trim()
    if (params.leakTestTime !== undefined) patch.leakTestTime = params.leakTestTime
    if (next === '待复检') patch.needsReview = false
    await db.isolationTickets.update(id, patch)
    return next
  },

  async advanceDuty(id, params) {
    const ticket = get().tickets.find((item) => item.id === id)
    if (!ticket) return null
    const next = ISOLATION_DUTY_FLOW[ticket.dutyState]
    if (!next) return null
    const patch: Partial<IsolationRow> = { dutyState: next, updatedAt: Date.now() }
    if (params.isolationScope !== undefined) patch.isolationScope = params.isolationScope.trim()
    if (params.dutyHandler !== undefined) patch.dutyHandler = params.dutyHandler.trim()
    if (params.retestPpm !== undefined) patch.retestPpm = Number(params.retestPpm) || 0
    if (next === '已放行') {
      const retest = Number(params.retestPpm ?? ticket.retestPpm) || 0
      if (!(retest > 0 && retest <= 50)) {
        throw new Error(`复检浓度 ${retest} ppm 未达标（≤ 50 ppm 才能放行）`)
      }
      patch.released = true
      patch.releasedAt = new Date().toISOString().slice(0, 16).replace('T', ' ')
    }
    await db.isolationTickets.update(id, patch)
    return next
  },

  async updateTicket(id, patch) {
    await db.isolationTickets.update(id, { ...patch, updatedAt: Date.now() })
  },

  async removeTicket(id) {
    await db.isolationTickets.delete(id)
  },

  async resolveReview(id, patch) {
    await db.isolationTickets.update(id, { ...patch, needsReview: false, updatedAt: Date.now() })
  },

  closedCount() {
    return get().tickets.filter(isTicketClosed).length
  },

  pendingReviewCount() {
    return get().tickets.filter((ticket) => ticket.needsReview).length
  }
}))

liveQuery(async () => (await db.isolationTickets.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)).subscribe({
  next: (rows) => useIsolationStore.setState({ tickets: rows, ready: true }),
  error: () => useIsolationStore.setState({ ready: true })
})
