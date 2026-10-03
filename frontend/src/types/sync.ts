/**
 * 回传包与对账同步类型
 *
 * 夜间抢修现场组与值班室各开一份页面，各自产生「回传包」。
 * 值班室导入回传包时先对账（reconcile）：
 * - 同 id 的行按归属字段合并（现场包只覆盖现场字段，值班包只覆盖值班字段）
 * - 同自然键但 id 不同（同一泄漏单被两边各开一遍）→ 冲突，两边都留，进人工队列
 * - 旧包缺少隔离字段 → legacy，转人工确认，不自动写库
 * 写入按检查点分批，失败后从最近检查点续传；重复导入同一包不新增泄漏单。
 */
import type { Patrol } from './patrol'
import type { Reading } from './reading'
import type { Leak } from './leak'
import type { IsolationTicket } from './isolation'

/** 回传来源：现场组 / 值班室 */
export type SyncOrigin = 'field' | 'duty'

/** 同步批次状态：待对账 → 对账完成 → 写入中（检查点）→ 已完成 / 失败可续传 / 待人工确认 */
export type SyncBatchState = '待对账' | '已对账' | '写入中' | '已完成' | '失败' | '待人工确认'

/** 冲突处理结论（人工处理后回填） */
export type ConflictResolution = 'pending' | 'keep-both' | 'merge' | 'discard-incoming'

/** 回传包：仅携带对应归属侧的字段段 */
export interface ReturnPackage {
  app: 'gbgaspress-return'
  /** 包 id：同一包重复导入据此幂等识别 */
  packageId: string
  origin: SyncOrigin
  packagedAt: string
  /** 包格式版本；旧包（无隔离段）据此识别 */
  packageVersion: number
  patrols?: Patrol[]
  readings?: Reading[]
  leaks?: Leak[]
  /** v2+ 才有；旧包缺该段 → 转人工确认 */
  isolations?: IsolationTicket[]
}

/** 当前回传包格式版本（含隔离作业票段） */
export const RETURN_PACKAGE_VERSION = 2
/** 旧版回传包（无隔离字段） */
export const LEGACY_PACKAGE_VERSION = 1

/** 对账差异类型 */
export type ReconcileDiffKind =
  | 'new' // 库中不存在，新增
  | 'identical' // 完全一致，跳过
  | 'field-update' // 同 id，仅现场归属字段变化
  | 'duty-update' // 同 id，仅值班归属字段变化
  | 'both-update' // 两侧字段都有变化
  | 'conflict' // 自然键相同但 id 不同（重复开单）→ 两边都留
  | 'legacy' // 旧包缺隔离字段 → 人工确认

export interface ReconcileDiff {
  kind: ReconcileDiffKind
  entity: 'patrol' | 'reading' | 'leak' | 'isolation'
  /** 包内行 id */
  incomingId: string
  /** 库内冲突/已存在行 id（new 时为空） */
  localId: string
  /** 自然键（leak 为 deviceId|foundTime；其余为 id） */
  naturalKey: string
  summary: string
  incoming: unknown
  local: unknown
}

/** 对账结果 */
export interface ReconcileReport {
  packageId: string
  origin: SyncOrigin
  legacy: boolean
  diffs: ReconcileDiff[]
  /** 新增/更新计数（不含冲突与旧包条目） */
  newCount: number
  updateCount: number
  identicalCount: number
  conflictCount: number
  legacyCount: number
}

/** 同步批次（检查点记录） */
export interface SyncBatch {
  id: string
  packageId: string
  origin: SyncOrigin
  fileName: string
  state: SyncBatchState
  legacy: boolean
  /** 对账快照（用于续传，不重新对账） */
  report: ReconcileReport | null
  /** 检查点：已成功写入的 diff 下标（按 entity 分组计数） */
  checkpoint: {
    patrol: number
    reading: number
    leak: number
    isolation: number
  }
  total: number
  applied: number
  conflictCount: number
  errorMessage: string
  createdAt: number
  updatedAt: number
}

/** 同步冲突（两边都留） */
export interface SyncConflict {
  id: string
  batchId: string
  packageId: string
  entity: 'leak' | 'isolation' | 'patrol' | 'reading'
  naturalKey: string
  incomingId: string
  localId: string
  /** 库内保留下来的「另一份」行 id（冲突时复制入库的副本） */
  duplicateRowId: string
  summary: string
  resolution: ConflictResolution
  note: string
  createdAt: number
  updatedAt: number
}

export const SYNC_BATCH_STATES: SyncBatchState[] = [
  '待对账',
  '已对账',
  '写入中',
  '已完成',
  '失败',
  '待人工确认'
]

export function emptyCheckpoint(): SyncBatch['checkpoint'] {
  return { patrol: 0, reading: 0, leak: 0, isolation: 0 }
}

/** 泄漏单自然键：同设备同发现时间视为同一张单（防夜间两边重复开单） */
export function leakNaturalKey(leak: Pick<Leak, 'deviceId' | 'foundTime'>): string {
  return `${leak.deviceId}|${leak.foundTime}`
}

/** 隔离票自然键：绑定泄漏单 */
export function isolationNaturalKey(ticket: Pick<IsolationTicket, 'leakId'>): string {
  return `iso:${ticket.leakId}`
}
