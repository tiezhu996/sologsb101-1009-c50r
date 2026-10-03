/** 泄漏处置：由异常读数派发的处置单，复检合格后闭环 */
export type LeakState = '待处置' | '已处置' | '已复检'

export interface Leak {
  id: string
  deviceId: string
  /** 冗余站点 id */
  stationId: string
  /**
   * 稳定业务键：跨端对账时识别「同一张泄漏单」。
   * 现场组和值班室夜间各自录隔离 / 测漏时可能各开一张，按 设备 + 发现日 + 浓度档位 归并，
   * 避免回传后同一泄漏单开两遍。重复导入、重复回传命中同键即视为同一单，不新增。
   */
  bizKey: string
  /** 泄漏浓度（ppm） */
  concentrationPpm: number
  /** 发现时间 YYYY-MM-DD */
  foundTime: string
  measure: string
  state: LeakState
  /** 复检浓度（ppm）——现场组录入 */
  retestValuePpm: number
  handler: string
  createdAt: number
  updatedAt: number
}

/** 浓度归并档位（ppm）：同设备同日测得浓度落在同一档视为同一泄漏单 */
export const LEAK_BIZKEY_PPM_BUCKET = 10

/**
 * 泄漏单稳定业务键：`lk|设备|发现日|浓度档位`。
 * 两边各开一张也能归并（不依赖任一方生成的单据 id）。
 */
export function leakBizKeyOf(deviceId: string, foundTime: string, concentrationPpm: number): string {
  const bucket = Math.round((Number(concentrationPpm) || 0) / LEAK_BIZKEY_PPM_BUCKET)
  return `lk|${deviceId || '?'}|${foundTime || '?'}|${bucket}`
}

export const LEAK_STATES: LeakState[] = ['待处置', '已处置', '已复检']

/** 泄漏处置状态机：待处置 → 已处置 → 已复检 */
export const LEAK_STATE_FLOW: Record<LeakState, LeakState | null> = {
  待处置: '已处置',
  已处置: '已复检',
  已复检: null
}

/** 复检合格阈值（ppm） */
export const LEAK_RETEST_PASS_PPM = 50

export interface LeakDraft {
  deviceId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: LeakState
  retestValuePpm: number
  handler: string
}

export const EMPTY_LEAK_DRAFT: LeakDraft = {
  deviceId: '',
  concentrationPpm: 0,
  foundTime: '',
  measure: '',
  state: '待处置',
  retestValuePpm: 0,
  handler: ''
}

export function createEmptyLeakDraft(): LeakDraft {
  return { ...EMPTY_LEAK_DRAFT }
}

export function retestPassed(value: number): boolean {
  return value > 0 && value <= LEAK_RETEST_PASS_PPM
}
