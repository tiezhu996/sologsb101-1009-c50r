/**
 * 隔离作业票：夜间抢修时现场组与值班室双线并行作业。
 * 一张票两套互不从属的状态：
 * - 现场轨（field）：拥有测点读数与处置措施
 * - 值班轨（duty）：拥有隔离范围与复检放行
 */
export type IsolationSide = 'field' | 'duty'

export const SIDE_LABEL: Record<IsolationSide, string> = {
  field: '现场组',
  duty: '值班室'
}

/** 现场轨状态：隔离后等待测漏 → 测漏处置中 → 措施落地 */
export type FieldIsolationState = '隔离待测' | '测漏中' | '已处置'

/** 值班轨状态：等待划定隔离范围 → 已隔离挂牌 → 复检合格放行 */
export type DutyIsolationState = '待划定' | '已隔离' | '已放行'

export const FIELD_ISOLATION_STATES: FieldIsolationState[] = ['隔离待测', '测漏中', '已处置']
export const DUTY_ISOLATION_STATES: DutyIsolationState[] = ['待划定', '已隔离', '已放行']

/** 现场状态机：隔离待测 → 测漏中 → 已处置 */
export const FIELD_ISOLATION_FLOW: Record<FieldIsolationState, FieldIsolationState | null> = {
  隔离待测: '测漏中',
  测漏中: '已处置',
  已处置: null
}

/** 值班状态机：待划定 → 已隔离 → 已放行（复检放行闭环） */
export const DUTY_ISOLATION_FLOW: Record<DutyIsolationState, DutyIsolationState | null> = {
  待划定: '已隔离',
  已隔离: '已放行',
  已放行: null
}

/** 现场测点读数（泄漏浓度，ppm） */
export interface MeasurePointReading {
  id: string
  /** 测点名称，如 调压器进口法兰 */
  pointName: string
  valuePpm: number
  /** 测量时刻 YYYY-MM-DD HH:mm */
  measuredAt: string
}

export interface IsolationTicket {
  id: string
  /** 作业票号，跨端对账的稳定业务标识之一 */
  ticketNo: string
  deviceId: string
  /** 冗余站点 id */
  stationId: string
  /** 关联泄漏处置单，抢修开票时可暂空，回传对账后回填 */
  leakId: string

  /* —— 现场组拥有：测点读数与处置措施 —— */
  fieldState: FieldIsolationState
  measurePointReadings: MeasurePointReading[]
  /** 处置措施 */
  measure: string
  fieldOperator: string
  /** 最近一次测量时刻 YYYY-MM-DD HH:mm */
  measuredAt: string
  fieldUpdatedAt: number

  /* —— 值班室拥有：隔离范围与复检放行 —— */
  dutyState: DutyIsolationState
  /** 隔离范围（关阀、泄压、挂牌等描述） */
  isolationScope: string
  isolatedBy: string
  /** 隔离生效时刻 YYYY-MM-DD HH:mm */
  isolatedAt: string
  /** 复检放行结论 */
  retestApproved: boolean
  retestApprover: string
  retestApprovedAt: string
  dutyUpdatedAt: number

  createdAt: number
  updatedAt: number
}

export interface IsolationTicketDraft {
  ticketNo: string
  deviceId: string
  stationId: string
  leakId: string
}

export const EMPTY_ISOLATION_TICKET_DRAFT: IsolationTicketDraft = {
  ticketNo: '',
  deviceId: '',
  stationId: '',
  leakId: ''
}

export function createEmptyIsolationTicketDraft(): IsolationTicketDraft {
  return { ...EMPTY_ISOLATION_TICKET_DRAFT }
}

/** 现场填写项：测点读数与处置措施（值班室字段不在此草稿内） */
export interface FieldTicketPatch {
  fieldState?: FieldIsolationState
  measure?: string
  fieldOperator?: string
  measuredAt?: string
  measurePointReadings?: MeasurePointReading[]
}

/** 值班填写项：隔离范围与复检放行（现场字段不在此草稿内） */
export interface DutyTicketPatch {
  dutyState?: DutyIsolationState
  isolationScope?: string
  isolatedBy?: string
  isolatedAt?: string
  retestApproved?: boolean
  retestApprover?: string
  retestApprovedAt?: string
}

/** 最新一条测点读数，无读数时返回 null */
export function latestReading(readings: MeasurePointReading[]): MeasurePointReading | null {
  if (readings.length === 0) return null
  return [...readings].sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0]
}
