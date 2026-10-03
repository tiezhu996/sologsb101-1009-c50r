/**
 * 导入对账模型：对账报告、字段归属、冲突留痕与人工确认队列的行结构。
 *
 * 对账口径：
 * - 先按稳定业务键比对，命中同一张泄漏单时绝不新增（重复导入不新增泄漏单）。
 * - 字段分归属：只采纳归属方的修改；非归属字段若两边不一致记为冲突，本地与回传两边都留存证。
 */
import type { Leak } from '@/types/leak'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { IsolationTicket, IsolationSide } from '@/types/isolation'
import type { SyncOrigin, SyncPackage } from '@/types/sync'

/** 对账实体种类 */
export type ReconcileEntityKind = 'leak' | 'patrol' | 'reading' | 'isolationTicket'

/** 对账结论动作 */
export type ReconcileAction = 'create' | 'update' | 'skip' | 'conflict'

export const RECONCILE_ACTION_LABEL: Record<ReconcileAction, string> = {
  create: '新增',
  update: '合并更新',
  skip: '一致跳过',
  conflict: '冲突挂起'
}

/** 冲突裁定方向 */
export type ConflictWinner = 'local' | 'incoming'

/** 单字段差异留痕 */
export interface FieldDiff {
  field: string
  label: string
  /** 归属方；归属字段直接采纳，非归属字段不一致才挂冲突 */
  owner: IsolationSide | 'shared' | 'shared-auto'
  localValue: unknown
  incomingValue: unknown
  /** 是否归属于本次回传包的导出方（true 则自动采纳） */
  ownedByOrigin: boolean
}

/** 一条对账明细 */
export interface ReconcileItem {
  kind: ReconcileEntityKind
  /** 实体稳定业务键 */
  bizKey: string
  entityId: string
  /** 命中的本地实体 id，未命中为空串 */
  localId: string
  title: string
  action: ReconcileAction
  /** 待写回的合并结果（update / create 时有效） */
  merged?: Leak | Patrol | Reading | IsolationTicket
  /** 冲突时的字段差异（冲突两边都留，不自动落库） */
  diffs: FieldDiff[]
}

/** 导入对账报告（按检查点逐条应用时逐条推进） */
export interface ReconcileReport {
  packageId: string
  origin: SyncOrigin
  exportedAt: string
  items: ReconcileItem[]
  /** 是否旧包（缺隔离字段）：整体转人工确认，不自动写入 */
  legacy: boolean
}

/* ============================ 本地辅助表行结构 ============================ */

/** 冲突留痕：本地与回传两边都留 */
export interface ConflictRow {
  id: string
  packageId: string
  origin: SyncOrigin
  kind: ReconcileEntityKind
  bizKey: string
  title: string
  localId: string
  /** 回传包内的实体 id */
  incomingId: string
  diffs: FieldDiff[]
  /** 冲突快照两边都留 */
  localSnapshot: unknown
  incomingSnapshot: unknown
  status: '待裁定' | '已留本地' | '已采回传'
  resolvedAt: string
  resolvedBy: string
  createdAt: number
  updatedAt: number
}

/** 导入台账：回传包处理检查点，支持写入失败后从检查点重试、重复包幂等 */
export type ImportLedgerStatus = '待写入' | '写入中' | '已完成' | '需人工确认'

export interface ImportLedgerRow {
  id: string
  packageId: string
  origin: SyncOrigin
  exportedAt: string
  /** 已成功应用到的条目下标（检查点，从 0 计）；初始 -1 表示一条未写 */
  appliedIndex: number
  /** 总条目数 */
  totalItems: number
  status: ImportLedgerStatus
  lastError: string
  /** 最近一次失败的注入步骤（断点演练用），无则为空串 */
  failStep: string
  importedAt: number
  updatedAt: number
}

/** 人工确认队列：旧包（缺隔离字段）整体挂起，值班长确认后才补写 */
export type ManualQueueStatus = '待确认' | '已确认导入' | '已忽略'

export interface ManualQueueEntry {
  id: string
  packageId: string
  origin: SyncOrigin
  exportedAt: string
  reason: string
  /** 完整回传包快照（含隔离缺失标记），确认时不再需要原文件 */
  payload: SyncPackage | null
  preview: {
    leaks: number
    patrols: number
    readings: number
    isolationTickets: number
  }
  status: ManualQueueStatus
  decidedBy: string
  decidedAt: string
  createdAt: number
  updatedAt: number
}
