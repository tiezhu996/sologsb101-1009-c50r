/** 巡检：按计划日期生成的巡检任务（夜间抢修双轨：现场态 + 值班态） */
export type PatrolState = '待巡检' | '已完成' | '漏检'

/** 现场态：现场组是否已录测点读数并回传 */
export type PatrolFieldState = '待录入' | '已录读'
/** 值班态：值班室是否已接收回传包并复检放行 */
export type PatrolDutyState = '待接收' | '已接收' | '已放行'

export interface Patrol {
  id: string
  stationId: string
  /** 计划日期 YYYY-MM-DD */
  planDate: string
  /** 实际日期，未执行时为空串 */
  patrolDate: string
  patrolman: string
  envNote: string
  state: PatrolState
  /** 现场轨：测点读数录入情况（缺省视为待录入） */
  fieldState?: PatrolFieldState
  /** 值班轨：回传包接收 / 复检放行情况（缺省视为待接收） */
  dutyState?: PatrolDutyState
  /** 现场处置措施（现场归属字段） */
  fieldMeasure?: string
  /** 值班室复检放行意见（值班归属字段） */
  dutyReleaseNote?: string
  createdAt: number
  updatedAt: number
}

export const PATROL_STATES: PatrolState[] = ['待巡检', '已完成', '漏检']
export const PATROL_FIELD_STATES: PatrolFieldState[] = ['待录入', '已录读']
export const PATROL_DUTY_STATES: PatrolDutyState[] = ['待接收', '已接收', '已放行']

/** 巡检状态机：待巡检 → 已完成；漏检 → 已完成（补检） */
export const PATROL_STATE_FLOW: Record<PatrolState, PatrolState | null> = {
  待巡检: '已完成',
  已完成: null,
  漏检: '已完成'
}

export interface PatrolDraft {
  stationId: string
  planDate: string
  patrolDate: string
  patrolman: string
  envNote: string
  state: PatrolState
}

export const EMPTY_PATROL_DRAFT: PatrolDraft = {
  stationId: '',
  planDate: '',
  patrolDate: '',
  patrolman: '',
  envNote: '',
  state: '待巡检'
}

/** 漏检条目：超期天数由计划日期与当前日期推导 */
export interface PatrolGap {
  patrol: Patrol
  /** 超期天数（计划日期距今天数） */
  overdueDays: number
  /** 是否已超期未检 */
  overdue: boolean
  /** 提示文案 */
  text: string
}

export function patrolLabel(patrol: Patrol, stationName: string): string {
  return `${stationName} · 计划 ${patrol.planDate}`
}
