/**
 * 回传包：现场组 / 值班室离线作业后导出、另一方导入对账的载体。
 * 双方使用同一份结构；携带数据来自哪一侧由 origin 标识，对账时按字段归属决定采纳方。
 */
import type { Leak } from '@/types/leak'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { IsolationTicket } from '@/types/isolation'

/** 回传包类型标识（区别于整库备份 app: 'gbgaspress'） */
export const SYNC_PACKAGE_APP = 'gbgaspress-sync'

/** 回传包格式版本 */
export const SYNC_PACKAGE_VERSION = 2

/** 旧版回传包版本（无隔离作业票字段），导入时转人工确认 */
export const LEGACY_SYNC_PACKAGE_VERSION = 1

export type SyncOrigin = 'field' | 'duty'

export const SYNC_ORIGIN_LABEL: Record<SyncOrigin, string> = {
  field: '现场组',
  duty: '值班室'
}

/**
 * 回传包。
 * v2 起携带隔离作业票；缺少 isolationTickets 字段（v1 旧包）的包导入时不自动落库，进人工确认队列。
 */
export interface SyncPackage {
  app: typeof SYNC_PACKAGE_APP
  packageVersion: number
  /** 包的稳定标识：同一分包重复回传时据此幂等，重复导入不新增泄漏单 */
  packageId: string
  /** 导出方：现场组 / 值班室 */
  origin: SyncOrigin
  exportedAt: string
  /** 导出人（现场巡检人或值班员） */
  exportedBy: string
  /** 说明，如 城东调压站夜间抢修回传 */
  remark: string
  leaks: Leak[]
  patrols: Patrol[]
  readings: Reading[]
  isolationTickets: IsolationTicket[]
}

/** 旧回传包：结构同 v2 但不含隔离字段 */
export type LegacySyncPackage = Omit<SyncPackage, 'packageVersion' | 'isolationTickets'> & {
  packageVersion?: number
  isolationTickets?: unknown
}

/** 判断解析出的对象是否为回传包（整库备份不算） */
export function isSyncPackage(value: unknown): value is SyncPackage | LegacySyncPackage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.app === SYNC_PACKAGE_APP && typeof candidate.packageId === 'string'
}

/**
 * 旧包判定：包结构有效但缺少隔离作业票字段（含字段但不是数组也算缺失）。
 * 按需求：旧包缺少隔离字段则转人工确认，不自动写入。
 */
export function isLegacyPackage(pkg: SyncPackage | LegacySyncPackage): boolean {
  if (!Array.isArray(pkg.isolationTickets)) return true
  return typeof pkg.packageVersion === 'number' && pkg.packageVersion < SYNC_PACKAGE_VERSION
}
