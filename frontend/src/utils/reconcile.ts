/**
 * 对账引擎（纯函数，不触碰数据库）：
 * 1. 稳定业务键比对：同一张泄漏单 / 作业票绝不因回传方 id 不同而新增。
 * 2. 字段归属：只采纳归属方字段；非归属字段两边不一致即记冲突，本地与回传都留存证。
 * 3. 结论分四类：新增 create / 合并更新 update / 一致跳过 skip / 冲突挂起 conflict。
 */
import type { Leak } from '@/types/leak'
import { leakBizKeyOf } from '@/types/leak'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { IsolationSide, IsolationTicket, MeasurePointReading } from '@/types/isolation'
import type { SyncOrigin, SyncPackage } from '@/types/sync'
import { isLegacyPackage } from '@/types/sync'
import type { FieldDiff, ReconcileEntityKind, ReconcileItem, ReconcileReport } from '@/types/reconcile'

/* ============================== 业务键 ============================== */

export function patrolBizKeyOf(patrol: Pick<Patrol, 'id' | 'stationId' | 'planDate'>): string {
  return `pa|${patrol.stationId || '?'}|${patrol.planDate || '?'}`
}

export function readingBizKeyOf(reading: Pick<Reading, 'patrolId' | 'pointId'>): string {
  return `rd|${reading.patrolId || '?'}|${reading.pointId || '?'}`
}

export function ticketBizKeyOf(ticket: Pick<IsolationTicket, 'id' | 'ticketNo'>): string {
  return ticket.ticketNo ? `iso|${ticket.ticketNo}` : `iso|id|${ticket.id}`
}

/* ============================ 字段归属定义 ============================ */

/**
 * 字段归属：
 * - field / duty：仅归属方可写，他方非空改写记冲突（两边都留）
 * - 'shared-auto'：共享测量值，以回传方为准自动合并（如同一泄漏两测浓度档位内取新值）
 * - 'shared'：共享身份事实（设备、发现日），两边不一致无法自动裁决，记冲突两边都留
 */
type FieldOwner = IsolationSide | 'shared' | 'shared-auto'

type FieldSpec = { field: string; label: string; owner: FieldOwner }

/**
 * 泄漏单字段归属：
 * - 现场组：泄漏/复检浓度、处置措施、处置人（测点读数与处置动作在现场）
 * - 值班室：处置状态（隔离放行 / 复检放行由值班签发）
 * - 设备、发现日为共享事实；浓度按业务键档位归并，两边实测略有差异不构成冲突
 */
const LEAK_FIELDS: FieldSpec[] = [
  { field: 'deviceId', label: '设备', owner: 'shared' },
  { field: 'stationId', label: '调压站', owner: 'shared' },
  { field: 'concentrationPpm', label: '泄漏浓度', owner: 'shared-auto' },
  { field: 'foundTime', label: '发现时间', owner: 'shared' },
  { field: 'measure', label: '处置措施', owner: 'field' },
  { field: 'handler', label: '处置人', owner: 'field' },
  { field: 'retestValuePpm', label: '复检浓度', owner: 'field' },
  { field: 'state', label: '处置状态', owner: 'duty' }
]

/** 巡检为现场作业：日期/巡检人/备注/状态全部归现场；值班室改动即非归属修改 */
const PATROL_FIELDS: FieldSpec[] = [
  { field: 'stationId', label: '调压站', owner: 'shared' },
  { field: 'planDate', label: '计划日期', owner: 'shared' },
  { field: 'patrolDate', label: '实际日期', owner: 'field' },
  { field: 'patrolman', label: '巡检人', owner: 'field' },
  { field: 'envNote', label: '现场备注', owner: 'field' },
  { field: 'state', label: '巡检状态', owner: 'field' }
]

/** 测点读数全部归现场组 */
const READING_FIELDS: FieldSpec[] = [
  { field: 'value', label: '读数', owner: 'field' },
  { field: 'isAbnormal', label: '异常标记', owner: 'field' },
  { field: 'deviationPct', label: '偏差率', owner: 'field' },
  { field: 'note', label: '备注', owner: 'field' }
]

/**
 * 隔离作业票：两套状态字段严格分属
 * - 现场：测点读数、措施、现场状态
 * - 值班：隔离范围、隔离挂牌、复检放行
 */
const TICKET_FIELDS: FieldSpec[] = [
  { field: 'deviceId', label: '设备', owner: 'shared' },
  { field: 'stationId', label: '调压站', owner: 'shared' },
  { field: 'leakId', label: '关联泄漏单', owner: 'shared' },
  { field: 'fieldState', label: '现场状态', owner: 'field' },
  { field: 'measurePointReadings', label: '测点读数', owner: 'field' },
  { field: 'measure', label: '处置措施', owner: 'field' },
  { field: 'fieldOperator', label: '现场操作人', owner: 'field' },
  { field: 'measuredAt', label: '最近测漏时刻', owner: 'field' },
  { field: 'dutyState', label: '值班状态', owner: 'duty' },
  { field: 'isolationScope', label: '隔离范围', owner: 'duty' },
  { field: 'isolatedBy', label: '隔离签发人', owner: 'duty' },
  { field: 'isolatedAt', label: '隔离生效时刻', owner: 'duty' },
  { field: 'retestApproved', label: '复检放行', owner: 'duty' },
  { field: 'retestApprover', label: '复检放行批准人', owner: 'duty' },
  { field: 'retestApprovedAt', label: '放行时刻', owner: 'duty' }
]

/* ============================== 值比较 ============================== */

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => JSON.stringify(normalize(item)))
      .sort()
      .map((item) => JSON.parse(item))
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalize(source[key])
        return acc
      }, {})
  }
  return value
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

/** 数字 / 字符串类归属字段做「有效值」判断，空串与 0 不覆盖现场已录内容 */
function isEmptyIncoming(field: string, value: unknown): boolean {
  if (field === 'measurePointReadings') return Array.isArray(value) && value.length === 0
  if (typeof value === 'string') return value.trim().length === 0
  if (typeof value === 'number') return !Number.isFinite(value) || value === 0
  if (typeof value === 'boolean') return false
  return value === null || value === undefined
}

/* ============================== 逐条比对 ============================== */

/**
 * 逐字段比对口径：
 * - 归属本包导出方的字段：有差异即采纳（回传空值不覆盖本地）。
 * - 归属另一方的字段：回传方未录（空值）视为未带该侧数据，忽略；
 *   若回传方确实填了与归属方本地不一致的值，说明两边都在改同一字段，记冲突两边都留。
 * - 双方共享的事实字段（如所属设备、发现日期）：两边不一致无法自动裁决，记冲突两边都留。
 */
function diffEntity(
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
  specs: FieldSpec[],
  origin: SyncOrigin
): { diffs: FieldDiff[]; ownedPatches: Record<string, unknown> } {
  const diffs: FieldDiff[] = []
  const ownedPatches: Record<string, unknown> = {}
  specs.forEach((spec) => {
    const localValue = local[spec.field]
    const incomingValue = incoming[spec.field]
    if (sameValue(localValue, incomingValue)) return
    if (spec.owner === origin) {
      // 归属方回传空值（未录）不覆盖本地既有内容
      if (isEmptyIncoming(spec.field, incomingValue)) return
      ownedPatches[spec.field] = incomingValue
      return
    }
    if (spec.owner === 'shared') {
      diffs.push({
        field: spec.field,
        label: spec.label,
        owner: spec.owner,
        localValue,
        incomingValue,
        ownedByOrigin: false
      })
      return
    }
    if (spec.owner === 'shared-auto') {
      // 共享测量值：以回传方为准自动合并（回传未录则跳过）
      if (!isEmptyIncoming(spec.field, incomingValue)) ownedPatches[spec.field] = incomingValue
      return
    }
    // 归属另一方：回传方没录这一侧的数据（空值）则忽略；两边都改且不一致才挂冲突两边都留
    if (isEmptyIncoming(spec.field, incomingValue)) return
    diffs.push({
      field: spec.field,
      label: spec.label,
      owner: spec.owner,
      localValue,
      incomingValue,
      ownedByOrigin: false
    })
  })
  return { diffs, ownedPatches }
}

interface MatchContext {
  leaks: Leak[]
  patrols: Patrol[]
  readings: Reading[]
  isolationTickets: IsolationTicket[]
}

type BusinessEntity = Leak | Patrol | Reading | IsolationTicket

function matchLocal(rows: BusinessEntity[], id: string, keyOf: (row: BusinessEntity) => string, bizKey: string): BusinessEntity | null {
  const byId = rows.find((row) => row.id === id)
  if (byId) return byId
  return rows.find((row) => keyOf(row) === bizKey) ?? null
}

function buildItem(params: {
  kind: ReconcileEntityKind
  specs: FieldSpec[]
  incoming: BusinessEntity
  local: BusinessEntity | null
  bizKey: string
  title: string
  origin: SyncOrigin
}): ReconcileItem {
  const { kind, specs, incoming, local, bizKey, title, origin } = params
  if (!local) {
    return { kind, bizKey, entityId: incoming.id, localId: '', title, action: 'create', diffs: [], merged: incoming }
  }
  const { diffs, ownedPatches } = diffEntity(local as unknown as Record<string, unknown>, incoming as unknown as Record<string, unknown>, specs, origin)
  if (diffs.length > 0) {
    // 冲突两边都留：不产出 merged，落库时由冲突表保留双方快照
    return { kind, bizKey, entityId: incoming.id, localId: local.id, title, action: 'conflict', diffs }
  }
  if (Object.keys(ownedPatches).length === 0) {
    return { kind, bizKey, entityId: incoming.id, localId: local.id, title, action: 'skip', diffs: [] }
  }
  const merged = { ...local, ...ownedPatches }
  return { kind, bizKey, entityId: incoming.id, localId: local.id, title, action: 'update', diffs: [], merged }
}

/* ============================== 报告组装 ============================== */

export interface BuildReportContext extends MatchContext {}

/**
 * 导入先对账：把回传包与本地四张业务表逐条比对，产出对账报告。
 * 不做任何写入；旧包（缺隔离字段）标记 legacy，由调用方转人工确认。
 */
export function buildReconcileReport(pkg: SyncPackage, ctx: BuildReportContext): ReconcileReport {
  const origin = pkg.origin
  const items: ReconcileItem[] = []

  ;(pkg.leaks ?? []).forEach((incoming) => {
    const withKey: Leak = { ...incoming, bizKey: incoming.bizKey || leakBizKeyOf(incoming.deviceId, incoming.foundTime, incoming.concentrationPpm) }
    const bizKey = withKey.bizKey
    const local = matchLocal(
      ctx.leaks,
      withKey.id,
      (row) => {
        const leak = row as Leak
        return leak.bizKey || leakBizKeyOf(leak.deviceId, leak.foundTime, leak.concentrationPpm)
      },
      bizKey
    )
    items.push(
      buildItem({
        kind: 'leak',
        specs: LEAK_FIELDS,
        incoming: withKey,
        local,
        bizKey,
        title: `泄漏处置单 ${withKey.foundTime} · ${withKey.concentrationPpm} ppm`,
        origin
      })
    )
  })

  ;(pkg.patrols ?? []).forEach((incoming) => {
    const bizKey = patrolBizKeyOf(incoming)
    const local = matchLocal(ctx.patrols, incoming.id, (row) => patrolBizKeyOf(row as Patrol), bizKey)
    items.push(buildItem({ kind: 'patrol', specs: PATROL_FIELDS, incoming, local, bizKey, title: `巡检计划 ${incoming.planDate}`, origin }))
  })

  ;(pkg.readings ?? []).forEach((incoming) => {
    const bizKey = readingBizKeyOf(incoming)
    const local = matchLocal(ctx.readings, incoming.id, (row) => readingBizKeyOf(row as Reading), bizKey)
    items.push(buildItem({ kind: 'reading', specs: READING_FIELDS, incoming, local, bizKey, title: `测点读数 ${bizKey}`, origin }))
  })

  ;(pkg.isolationTickets ?? []).forEach((incoming) => {
    const bizKey = ticketBizKeyOf(incoming)
    const local = matchLocal(ctx.isolationTickets, incoming.id, (row) => ticketBizKeyOf(row as IsolationTicket), bizKey)
    items.push(
      buildItem({
        kind: 'isolationTicket',
        specs: TICKET_FIELDS,
        incoming,
        local,
        bizKey,
        title: `隔离作业票 ${incoming.ticketNo || incoming.id}`,
        origin
      })
    )
  })

  return {
    packageId: pkg.packageId,
    origin,
    exportedAt: pkg.exportedAt,
    items,
    legacy: isLegacyPackage(pkg)
  }
}

/** 对账汇总，供预览 UI 使用 */
export function summarizeReport(report: ReconcileReport): Record<ReconcileItem['action'], number> {
  const summary: Record<ReconcileItem['action'], number> = { create: 0, update: 0, skip: 0, conflict: 0 }
  report.items.forEach((item) => {
    summary[item.action] += 1
  })
  return summary
}

/** 合并一张隔离票的归属字段（冲突裁定采用回传时复用），只取指定归属的字段 */
export function pickTicketSideFields(ticket: Partial<IsolationTicket>, side: IsolationSide): Partial<IsolationTicket> {
  const fieldNames = TICKET_FIELDS.filter((spec) => spec.owner === side).map((spec) => spec.field)
  return fieldNames.reduce<Record<string, unknown>>((acc, name) => {
    if (ticket[name as keyof IsolationTicket] !== undefined) acc[name] = ticket[name as keyof IsolationTicket]
    return acc
  }, {}) as Partial<IsolationTicket>
}

/** 按归属侧取测点读数最新值（UI / 导出复用） */
export function maxReadingPpm(readings: MeasurePointReading[]): number {
  return readings.reduce((max, item) => Math.max(max, Number(item.valuePpm) || 0), 0)
}
