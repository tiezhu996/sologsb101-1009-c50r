/**
 * 隔离作业票：夜间抢修双轨状态
 * - 现场轨（field）：测漏读数、处置措施，由现场组回传
 * - 值班轨（duty）：隔离范围划定、复检放行，由值班室回传
 * 两侧各开一份页面独立推进，导入时按归属字段合并，互不覆盖。
 */

/** 现场态：测漏 → 处置 → 待复检（等待值班室复检放行） */
export type IsolationFieldState = '测漏中' | '已处置' | '待复检'
/** 值班态：隔离范围划定 → 已隔离 → 复检通过放行 */
export type IsolationDutyState = '待划定' | '已隔离' | '已放行'

export interface IsolationTicket {
  id: string
  /** 关联泄漏处置单（一对一，以泄漏单为抢修源头） */
  leakId: string
  deviceId: string
  /** 冗余站点 id */
  stationId: string
  /** 作业票编号，现场与值班室对账用的业务号 */
  ticketNo: string

  /* ---------- 现场归属字段（现场组页面可写） ---------- */
  fieldState: IsolationFieldState
  /** 测漏读数（ppm），现场仪器实测 */
  leakTestPpm: number
  /** 现场处置措施（如 更换密封垫、紧固法兰） */
  fieldMeasure: string
  /** 现场作业人 */
  fieldHandler: string
  /** 测漏时间 YYYY-MM-DD HH:mm */
  leakTestTime: string

  /* ---------- 值班归属字段（值班室页面可写） ---------- */
  dutyState: IsolationDutyState
  /** 隔离范围描述（如 1# 调压器进出口双阀之间管段） */
  isolationScope: string
  /** 复检读数（ppm），值班室复检 */
  retestPpm: number
  /** 是否复检放行 */
  released: boolean
  /** 值班放行/复检人 */
  dutyHandler: string
  /** 放行时间 YYYY-MM-DD HH:mm */
  releasedAt: string

  /** 由哪个回传包导入（同步溯源，手工新建为空） */
  importPackageId?: string
  /** 与哪张作业票重复（自然键冲突时两边都留，互相标记） */
  dupOf?: string
  /** 旧包缺隔离字段或冲突待值班室人工确认 */
  needsReview?: boolean
  createdAt: number
  updatedAt: number
}

export const ISOLATION_FIELD_STATES: IsolationFieldState[] = ['测漏中', '已处置', '待复检']
export const ISOLATION_DUTY_STATES: IsolationDutyState[] = ['待划定', '已隔离', '已放行']

/** 现场态状态机：测漏中 → 已处置 → 待复检（交值班室复检） */
export const ISOLATION_FIELD_FLOW: Record<IsolationFieldState, IsolationFieldState | null> = {
  测漏中: '已处置',
  已处置: '待复检',
  待复检: null
}

/** 值班态状态机：待划定 → 已隔离 → 已放行（复检合格才放行） */
export const ISOLATION_DUTY_FLOW: Record<IsolationDutyState, IsolationDutyState | null> = {
  待划定: '已隔离',
  已隔离: '已放行',
  已放行: null
}

/** 隔离作业票是否闭环：现场待复检且值班已放行 */
export function isTicketClosed(ticket: Pick<IsolationTicket, 'fieldState' | 'dutyState'>): boolean {
  return ticket.fieldState === '待复检' && ticket.dutyState === '已放行'
}

export interface IsolationDraft {
  ticketNo: string
  fieldState: IsolationFieldState
  leakTestPpm: number
  fieldMeasure: string
  fieldHandler: string
  leakTestTime: string
  dutyState: IsolationDutyState
  isolationScope: string
  retestPpm: number
  released: boolean
  dutyHandler: string
  releasedAt: string
}

export function createEmptyIsolationDraft(stationId: string, leakId: string, deviceId: string): IsolationDraft {
  void stationId
  void leakId
  void deviceId
  return {
    ticketNo: '',
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
    releasedAt: ''
  }
}

/** 生成作业票业务号：ISO-yyyymmdd-序号段 */
export function buildTicketNo(seed = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `ISO-${new Date(seed).toISOString().slice(0, 10).replace(/-/g, '')}-${rand}`
}
