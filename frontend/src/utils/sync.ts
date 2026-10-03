/**
 * 回传包导入引擎：
 * - 导入先对账：buildReconcileReport 产出逐条结论
 * - 幂等：同 packageId 的包只处理一次，重复导入直接返回且不新增泄漏单
 * - 检查点：逐条独立事务写入，台账记录 appliedIndex；失败后从检查点续传，已写入条目不重复
 * - 冲突两边都留：冲突条目写 conflicts 表，本地数据不动
 * - 旧包缺隔离字段：不写入，转人工确认队列
 */
import { createId, db, type IsolationTicketRow, type LeakRow, type PatrolRow, type ReadingRow } from '@/utils/db'
import {
  isLegacyPackage,
  isSyncPackage,
  LEGACY_SYNC_PACKAGE_VERSION,
  SYNC_PACKAGE_APP,
  SYNC_PACKAGE_VERSION,
  type LegacySyncPackage,
  type SyncOrigin,
  type SyncPackage
} from '@/types/sync'
import {
  buildReconcileReport,
  readingBizKeyOf,
  summarizeReport,
  ticketBizKeyOf
} from '@/utils/reconcile'
import type { Leak } from '@/types/leak'
import { leakBizKeyOf } from '@/types/leak'
import type { IsolationTicket } from '@/types/isolation'
import { judgeReading } from '@/utils/range'
import type { ConflictRow, ImportLedgerRow, ManualQueueEntry, ReconcileItem, ReconcileReport } from '@/types/reconcile'

/* ============================== 打包 ============================== */

export interface BuildPackageOptions {
  origin: SyncOrigin
  exportedBy: string
  remark: string
  stationId?: string
}

/** 从当前库导出一个回传包（夜间抢修结束，现场组或值班室各自回传） */
export async function buildSyncPackage(options: BuildPackageOptions): Promise<SyncPackage> {
  const stationMatch = (stationId: string): boolean => !options.stationId || options.stationId === stationId
  const [allLeaks, patrols, readings, tickets] = await Promise.all([
    db.leaks.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.isolationTickets.toArray()
  ])
  const allPatrols = patrols.filter((row) => stationMatch(row.stationId)).map(stripRevision)
  const patrolIds = new Set(allPatrols.map((row) => row.id))
  const allReadings = readings.filter((row) => patrolIds.has(row.patrolId)).map(stripRevision)
  const allTickets = tickets
    .filter((row) => stationMatch(row.stationId))
    .map((row) => stripRevision(projectTicketSide(row as IsolationTicket, options.origin)))

  return {
    app: SYNC_PACKAGE_APP,
    packageVersion: SYNC_PACKAGE_VERSION,
    packageId: createId('pkg'),
    origin: options.origin,
    exportedAt: new Date().toISOString(),
    exportedBy: options.exportedBy.trim(),
    remark: options.remark.trim(),
    // 回传包只携带本方归属字段：对方侧文本/数值清空（对账时空值不覆盖本地）
    leaks: allLeaks
      .filter((row) => stationMatch(row.stationId))
      .map((row) => {
        const projected = projectLeakSide(stripRevision(row), options.origin)
        return { ...projected, bizKey: row.bizKey || leakBizKeyOf(row.deviceId, row.foundTime, row.concentrationPpm) }
      }),
    // 巡检与测点读数整体归现场：值班包不带这两类，避免非归属字段参与对账
    patrols: options.origin === 'field' ? allPatrols : [],
    readings: options.origin === 'field' ? allReadings : [],
    isolationTickets: allTickets
  }
}

/**
 * 泄漏单按导出方投影：对方侧自由填写字段清空（空值在对账时不会覆盖本地）。
 * state 是值班状态机字段，现场包携带也无妨——与本地一致即跳过，不一致才挂冲突。
 */
function projectLeakSide(leak: Leak, origin: SyncOrigin): Leak {
  if (origin === 'field') return leak
  return { ...leak, measure: '', handler: '', retestValuePpm: 0 }
}

/** 隔离票按导出方投影：对方轨自由填写字段清空，两轨状态机字段原样保留 */
function projectTicketSide(ticket: IsolationTicket, origin: SyncOrigin): IsolationTicket {
  if (origin === 'field') {
    return {
      ...ticket,
      isolationScope: '',
      isolatedBy: '',
      isolatedAt: '',
      retestApproved: false,
      retestApprover: '',
      retestApprovedAt: ''
    }
  }
  return {
    ...ticket,
    measurePointReadings: [],
    measure: '',
    fieldOperator: '',
    measuredAt: ''
  }
}

function stripRevision<T extends object>(row: T): T {
  const { revision: _revision, ...rest } = (row as unknown) as Record<string, unknown> & { revision?: number }
  return rest as unknown as T
}

/* ============================== 解析与暂存 ============================== */

export type StageOutcome =
  | { kind: 'invalid'; message: string }
  | { kind: 'duplicate'; ledger: ImportLedgerRow }
  | { kind: 'resumed'; pkg: SyncPackage; ledger: ImportLedgerRow; report: ReconcileReport }
  | { kind: 'legacy'; entry: ManualQueueEntry; ledger: ImportLedgerRow }
  | { kind: 'ready'; pkg: SyncPackage; report: ReconcileReport; ledger: ImportLedgerRow }

function sanitizePackage(raw: LegacySyncPackage): SyncPackage {
  return {
    app: SYNC_PACKAGE_APP,
    packageVersion: typeof raw.packageVersion === 'number' ? raw.packageVersion : LEGACY_SYNC_PACKAGE_VERSION,
    packageId: raw.packageId,
    origin: raw.origin === 'duty' ? 'duty' : 'field',
    exportedAt: raw.exportedAt,
    exportedBy: raw.exportedBy ?? '',
    remark: raw.remark ?? '',
    leaks: Array.isArray(raw.leaks) ? raw.leaks : [],
    patrols: Array.isArray(raw.patrols) ? raw.patrols : [],
    readings: Array.isArray(raw.readings) ? raw.readings : [],
    // 旧包没有隔离票，按空数组归一，但仍会被 isLegacyPackage 判为旧包
    isolationTickets: Array.isArray(raw.isolationTickets) ? (raw.isolationTickets as SyncPackage['isolationTickets']) : []
  }
}

async function readBusinessContext() {
  const [leaks, patrols, readings, isolationTickets] = await Promise.all([
    db.leaks.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.isolationTickets.toArray()
  ])
  return { leaks, patrols, readings, isolationTickets }
}

/**
 * 导入先对账：解析回传包、幂等查重、生成报告与导入台账。
 * 不写业务数据；旧包直接挂人工队列。
 */
export async function stageImport(fileContent: string): Promise<StageOutcome> {
  let parsed: unknown
  try {
    parsed = JSON.parse(fileContent)
  } catch {
    return { kind: 'invalid', message: '文件不是合法 JSON' }
  }
  if (!isSyncPackage(parsed)) {
    return { kind: 'invalid', message: '文件不是本系统回传包（缺少 app / packageId 标识）' }
  }
  const pkg = sanitizePackage(parsed)

  // 幂等：台账已存在则绝不重复处理
  const existed = await db.importLedger.where('packageId').equals(pkg.packageId).first()
  const ctx = await readBusinessContext()
  const report = buildReconcileReport(pkg, ctx)

  if (existed) {
    if (existed.status === '已完成') return { kind: 'duplicate', ledger: existed }
    if (existed.status === '需人工确认') {
      return { kind: 'legacy', entry: (await db.manualQueue.where('packageId').equals(pkg.packageId).first()) as ManualQueueEntry, ledger: existed }
    }
    // 待写入 / 写入中：从检查点恢复
    return { kind: 'resumed', pkg, ledger: existed, report }
  }

  const now = Date.now()
  const ledger: ImportLedgerRow = {
    id: createId('imp'),
    packageId: pkg.packageId,
    origin: pkg.origin,
    exportedAt: pkg.exportedAt,
    appliedIndex: -1,
    totalItems: report.items.length,
    status: '待写入',
    lastError: '',
    failStep: '',
    importedAt: now,
    updatedAt: now
  }

  // 旧包缺少隔离字段：不自动写入，转人工确认
  if (isLegacyPackage(pkg)) {
    ledger.status = '需人工确认'
    ledger.lastError = '旧版回传包缺少隔离作业票字段，需人工确认'
    const entry: ManualQueueEntry = {
      id: createId('mq'),
      packageId: pkg.packageId,
      origin: pkg.origin,
      exportedAt: pkg.exportedAt,
      reason: '旧版回传包（v1）缺少隔离作业票字段，按规程转值班长人工确认后再导入',
      payload: pkg,
      preview: {
        leaks: pkg.leaks.length,
        patrols: pkg.patrols.length,
        readings: pkg.readings.length,
        isolationTickets: 0
      },
      status: '待确认',
      decidedBy: '',
      decidedAt: '',
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.importLedger, db.manualQueue], async () => {
      await db.importLedger.put(ledger)
      await db.manualQueue.put(entry)
    })
    return { kind: 'legacy', entry, ledger }
  }

  await db.importLedger.put(ledger)
  return { kind: 'ready', pkg, report, ledger }
}

/* ============================ 逐条应用（检查点） ============================ */

export interface ApplyOptions {
  /** 断点演练：在该序号条目写入前抛错（下标从 0 计） */
  failAtIndex?: number
}

export interface ApplyResult {
  applied: number
  conflicts: number
  skipped: number
  created: number
  updated: number
  failed: boolean
  error: string
  failedIndex: number
  ledger: ImportLedgerRow
}

/** 重新组装对账报告（断点续传时上下文可能已变化，重新对账保证检查点准确） */
async function refreshReport(pkg: SyncPackage): Promise<ReconcileReport> {
  return buildReconcileReport(pkg, await readBusinessContext())
}

async function putLeak(row: Leak): Promise<void> {
  const next: LeakRow = {
    ...row,
    bizKey: row.bizKey || leakBizKeyOf(row.deviceId, row.foundTime, row.concentrationPpm),
    revision: 3
  }
  await db.leaks.put(next)
}

async function putPatrol(row: PatrolRow): Promise<void> {
  await db.patrols.put(row.revision ? row : { ...row, revision: 3 })
}

async function putReading(row: ReadingRow): Promise<void> {
  // 读数回传后按本地点位标准重算偏差，避免两端标准值不一致导致误判
  const point = await db.points.get(row.pointId)
  if (point) {
    const judgement = judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
    row = { ...row, isAbnormal: judgement.isAbnormal, deviationPct: judgement.deviationPct }
  }
  await db.readings.put(row.revision ? row : { ...row, revision: 3 })
}

async function putTicket(row: IsolationTicketRow): Promise<void> {
  await db.isolationTickets.put(row.revision ? row : { ...row, revision: 3 })
}

/** 应用单条对账结论（独立事务，失败不回滚此前已提交条目） */
async function applyOne(item: ReconcileItem, origin: SyncOrigin, packageId: string): Promise<'written' | 'conflict' | 'skipped'> {
  if (item.action === 'skip') return 'skipped'
  if (item.action === 'conflict') {
    const now = Date.now()
    const conflict: ConflictRow = {
      id: createId('cf'),
      packageId,
      origin,
      kind: item.kind,
      bizKey: item.bizKey,
      title: item.title,
      localId: item.localId,
      incomingId: item.entityId,
      diffs: item.diffs,
      // 冲突两边都留：快照本地与回传原值，等待人工裁定
      localSnapshot: await snapshotLocal(item),
      incomingSnapshot: item.entityId ? await snapshotIncoming(item) : null,
      status: '待裁定',
      resolvedAt: '',
      resolvedBy: '',
      createdAt: now,
      updatedAt: now
    }
    await db.conflicts.put(conflict)
    return 'conflict'
  }

  const merged = item.merged as (LeakRow | PatrolRow | ReadingRow | IsolationTicketRow) & { revision?: number }
  if (!merged) return 'skipped'
  const now = Date.now()
  const stamped = { ...merged, updatedAt: Math.max(merged.updatedAt ?? 0, now) }

  if (item.kind === 'leak') {
    await db.transaction('rw', [db.leaks], async () => {
      // 创建前最后按业务键兜底：重复导入不新增泄漏单
      const leakRow = stamped as LeakRow
      const key = leakRow.bizKey || leakBizKeyOf(leakRow.deviceId, leakRow.foundTime, leakRow.concentrationPpm)
      const dup = await db.leaks.where('bizKey').equals(key).first()
      if (item.action === 'create' && dup) {
        await db.leaks.update(dup.id, {
          measure: leakRow.measure || dup.measure,
          handler: leakRow.handler || dup.handler,
          retestValuePpm: leakRow.retestValuePpm || dup.retestValuePpm,
          updatedAt: now
        })
        return
      }
      await putLeak({ ...leakRow, bizKey: key, id: dup ? dup.id : leakRow.id })
    })
  } else if (item.kind === 'patrol') {
    await putPatrol(stamped as PatrolRow)
  } else if (item.kind === 'reading') {
    await putReading(stamped as ReadingRow)
  } else {
    await putTicket(stamped as IsolationTicketRow)
  }
  return 'written'
}

async function snapshotLocal(item: ReconcileItem): Promise<unknown> {
  if (!item.localId) return null
  const table = tableOf(item.kind)
  return table ? table.get(item.localId) : null
}

async function snapshotIncoming(item: ReconcileItem): Promise<unknown> {
  // 回传原值在差异明细里按字段留存；整体快照从 conflicts diffs 即可复原，这里保留结构化引用
  return item.diffs.reduce<Record<string, unknown>>((acc, diff) => {
    acc[diff.field] = diff.incomingValue
    return acc
  }, {})
}

function tableOf(kind: ReconcileItem['kind']) {
  if (kind === 'leak') return db.leaks
  if (kind === 'patrol') return db.patrols
  if (kind === 'reading') return db.readings
  return db.isolationTickets
}

/**
 * 按检查点写入回传包。每条独立事务，成功后推进台账 appliedIndex；
 * 写入失败（含断点演练注入）时停在失败条目，之后调用本函数即从检查点重试。
 */
export async function applyPackage(pkg: SyncPackage, options: ApplyOptions = {}): Promise<ApplyResult> {
  const report = await refreshReport(pkg)
  const ledger = await db.importLedger.where('packageId').equals(pkg.packageId).first()
  const empty: ApplyResult = {
    applied: 0,
    conflicts: 0,
    skipped: 0,
    created: 0,
    updated: 0,
    failed: false,
    error: '',
    failedIndex: -1,
    ledger: ledger as ImportLedgerRow
  }
  if (!ledger) return { ...empty, failed: true, error: '导入台账不存在，请重新对账' }
  if (ledger.status === '已完成') return empty

  const result = { ...empty }
  let appliedIndex = ledger.appliedIndex

  for (let index = appliedIndex + 1; index < report.items.length; index += 1) {
    const item = report.items[index]
    try {
      if (options.failAtIndex === index) {
        throw new Error(`断点演练：第 ${index + 1} 条写入失败（模拟网络中断）`)
      }
      const outcome = await applyOne(item, pkg.origin, pkg.packageId)
      if (outcome === 'conflict') result.conflicts += 1
      else if (outcome === 'skipped') result.skipped += 1
      else {
        result.applied += 1
        if (item.action === 'create') result.created += 1
        if (item.action === 'update') result.updated += 1
      }
      appliedIndex = index
      await db.importLedger.update(ledger.id, {
        appliedIndex,
        status: '写入中',
        lastError: '',
        failStep: options.failAtIndex === index ? String(index) : '',
        updatedAt: Date.now()
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '写入失败'
      await db.importLedger.update(ledger.id, {
        appliedIndex,
        status: '写入中',
        lastError: message,
        failStep: String(index),
        updatedAt: Date.now()
      })
      result.failed = true
      result.error = message
      result.failedIndex = index
      result.ledger = (await db.importLedger.get(ledger.id)) as ImportLedgerRow
      return result
    }
  }

  const refreshedLedger = (await db.importLedger.update(ledger.id, {
    appliedIndex: report.items.length - 1,
    status: '已完成',
    lastError: '',
    failStep: '',
    updatedAt: Date.now()
  }),
    (await db.importLedger.get(ledger.id)) as ImportLedgerRow)
  result.ledger = refreshedLedger
  return result
}

/* ============================== 冲突裁定 ============================== */

/**
 * 冲突两边都留后的人工裁定：
 * - local：维持本地，仅把冲突标记关闭
 * - incoming：按回传值覆盖冲突字段（归属表更新），再关闭冲突
 */
export async function resolveConflict(conflictId: string, winner: 'local' | 'incoming', operator: string): Promise<void> {
  const conflict = await db.conflicts.get(conflictId)
  if (!conflict || conflict.status !== '待裁定') return
  const now = new Date().toISOString()
  await db.transaction(
    'rw',
    [db.conflicts, db.leaks, db.patrols, db.readings, db.isolationTickets],
    async () => {
      if (winner === 'incoming') {
        const patch: Record<string, unknown> = {}
        conflict.diffs.forEach((diff) => {
          patch[diff.field] = diff.incomingValue
        })
        patch.updatedAt = Date.now()
        if (conflict.kind === 'leak') {
          await db.leaks.update(conflict.localId, patch as Partial<LeakRow>)
        } else if (conflict.kind === 'patrol') {
          await db.patrols.update(conflict.localId, patch as Partial<PatrolRow>)
        } else if (conflict.kind === 'reading') {
          const current = await db.readings.get(conflict.localId)
          if (current) {
            const point = await db.points.get(current.pointId)
            const value = typeof patch.value === 'number' ? patch.value : current.value
            if (point) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              patch.isAbnormal = judgement.isAbnormal
              patch.deviationPct = judgement.deviationPct
            }
            await db.readings.update(conflict.localId, patch as Partial<ReadingRow>)
          }
        } else {
          await db.isolationTickets.update(conflict.localId, patch as Partial<IsolationTicketRow>)
        }
      }
      await db.conflicts.update(conflictId, {
        status: winner === 'local' ? '已留本地' : '已采回传',
        resolvedAt: now,
        resolvedBy: operator.trim() || '值班长',
        updatedAt: Date.now()
      })
    }
  )
}

/* ============================ 旧包人工确认 ============================ */

/**
 * 值班长确认旧包：此时按最新库重新对账后走同一套检查点写入流程。
 * 旧包仍缺隔离票，确认代表知悉该差异并按现场既有隔离安排继续。
 */
export async function confirmLegacyPackage(entryId: string, operator: string): Promise<ApplyResult | { failed: true; error: string }> {
  const entry = await db.manualQueue.get(entryId)
  if (!entry || entry.status !== '待确认' || !entry.payload) {
    return { failed: true, error: '人工队列条目不可确认' }
  }
  const pkg = entry.payload
  const result = await applyPackage(pkg)
  await db.manualQueue.update(entryId, {
    status: '已确认导入',
    decidedBy: operator.trim() || '值班长',
    decidedAt: new Date().toISOString(),
    updatedAt: Date.now()
  })
  await db.importLedger.where('packageId').equals(pkg.packageId).modify({ status: '已完成' })
  return result
}

export async function ignoreLegacyPackage(entryId: string, operator: string): Promise<void> {
  const entry = await db.manualQueue.get(entryId)
  if (!entry) return
  await db.manualQueue.update(entryId, {
    status: '已忽略',
    decidedBy: operator.trim() || '值班长',
    decidedAt: new Date().toISOString(),
    updatedAt: Date.now(),
    payload: null
  })
  await db.importLedger.where('packageId').equals(entry.packageId).modify({ status: '已完成', lastError: '旧包已人工忽略' })
}

/* ============================== 工具导出 ============================== */

export { summarizeReport, readingBizKeyOf, ticketBizKeyOf }
