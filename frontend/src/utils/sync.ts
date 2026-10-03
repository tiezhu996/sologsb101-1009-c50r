/**
 * 回传包同步引擎
 * - 导入先对账（reconcilePackage），再按检查点分批写入
 * - 写入失败保存检查点，状态置「失败」，可从检查点续传（已写入的跳过）
 * - 同一 packageId 的包重复导入：已有批次直接复用，不重复新增泄漏单
 * - 冲突（同自然键不同 id）：两边都留，入 syncConflicts 并互相标记 dupOf
 * - 旧包：仅登记批次与待确认条目，不自动写库，转人工确认
 */
import {
  createId,
  db,
  type LeakRow,
  type IsolationRow,
  type PatrolRow,
  type ReadingRow,
  type SyncBatchRow,
  type SyncConflictRow
} from '@/utils/db'
import {
  LEAK_DUTY_KEYS,
  LEAK_FIELD_KEYS,
  PATROL_DUTY_KEYS,
  PATROL_FIELD_KEYS,
  READING_FIELD_KEYS,
  ISO_DUTY_KEYS,
  ISO_FIELD_KEYS,
  reconcilePackage,
  type ReconcileContext
} from '@/utils/reconcile'
import {
  leakNaturalKey,
  type ReconcileDiff,
  type ReconcileReport,
  type ReturnPackage,
  type SyncBatch
} from '@/types/sync'

/** 解析回传包 JSON（容错） */
export function parseReturnPackage(raw: string): ReturnPackage {
  const parsed = JSON.parse(raw) as Partial<ReturnPackage>
  if (!parsed || parsed.app !== 'gbgaspress-return' || typeof parsed.packageId !== 'string' || !parsed.packageId) {
    throw new Error('不是有效的回传包（缺少 packageId 或 app 标识）')
  }
  if (parsed.origin !== 'field' && parsed.origin !== 'duty') {
    throw new Error('回传包来源非法（origin 必须为 field / duty）')
  }
  return parsed as ReturnPackage
}

async function buildContext(): Promise<ReconcileContext> {
  const [patrols, readings, leaks, isolations] = await Promise.all([
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.isolationTickets.toArray()
  ])
  return { patrols, readings, leaks, isolations }
}

/** 只挑选归属字段，避免覆盖对方侧的数据 */
function pickOwned<T extends object>(row: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  keys.forEach((key) => {
    const value = row[key]
    if (value !== undefined) out[key] = value
  })
  return out
}

/**
 * 创建并对账一个导入批次。
 * 幂等：同一 packageId 已存在批次时直接返回既有批次（重复导入不新增任何单据）。
 */
export async function openImportBatch(pkg: ReturnPackage, fileName: string): Promise<{ batch: SyncBatchRow; reused: boolean }> {
  const existing = await db.syncBatches.where('packageId').equals(pkg.packageId).first()
  if (existing) {
    return { batch: existing, reused: true }
  }
  const ctx = await buildContext()
  const report = reconcilePackage(pkg, ctx)
  const now = Date.now()
  const total = report.diffs.filter((d) => d.kind !== 'identical' && d.kind !== 'legacy').length
  const batch: SyncBatchRow = {
    id: createId('batch'),
    packageId: pkg.packageId,
    origin: pkg.origin,
    fileName,
    state: report.legacy ? '待人工确认' : '已对账',
    legacy: report.legacy,
    report,
    checkpoint: { patrol: 0, reading: 0, leak: 0, isolation: 0 },
    total,
    applied: 0,
    conflictCount: report.conflictCount,
    errorMessage: '',
    createdAt: now,
    updatedAt: now,
    revision: 3
  }
  await db.syncBatches.put(batch)
  return { batch, reused: false }
}

type Checkpoint = SyncBatchRow['checkpoint']
type Progress = (increment: number, cursor: Checkpoint) => Promise<void>

/** 从检查点应用对账结果；失败抛出并保留检查点，可再次调用续传 */
export async function applyBatch(batchId: string): Promise<SyncBatchRow> {
  const batch = await db.syncBatches.get(batchId)
  if (!batch) throw new Error('同步批次不存在')
  if (!batch.report) throw new Error('批次尚未完成对账')
  if (batch.legacy || batch.state === '待人工确认') {
    throw new Error('旧版回传包缺少隔离字段，请先在人工确认队列处理')
  }
  if (batch.state === '已完成') return batch

  const report: ReconcileReport = batch.report
  const groups: Record<ReconcileDiff['entity'], ReconcileDiff[]> = {
    patrol: report.diffs.filter((d) => d.entity === 'patrol'),
    reading: report.diffs.filter((d) => d.entity === 'reading'),
    leak: report.diffs.filter((d) => d.entity === 'leak'),
    isolation: report.diffs.filter((d) => d.entity === 'isolation')
  }

  await db.syncBatches.update(batchId, { state: '写入中', errorMessage: '', updatedAt: Date.now() })

  const checkpoint = { ...batch.checkpoint }
  let applied = batch.applied
  const persist = async (): Promise<void> => {
    await db.syncBatches.update(batchId, { checkpoint: { ...checkpoint }, applied, updatedAt: Date.now() })
  }
  // 逐条从检查点续传；每条成功即落「实体游标 + 应用计数」，失败后重跑从断点继续
  const progress: Progress = async (increment, cursor) => {
    if (increment === 0) return
    applied += increment
    checkpoint.patrol = cursor.patrol
    checkpoint.reading = cursor.reading
    checkpoint.leak = cursor.leak
    checkpoint.isolation = cursor.isolation
    await persist()
  }

  try {
    // 逐条从检查点续传；每条成功即落检查点，失败后重跑从断点继续
    checkpoint.patrol = await applyPatrols(groups.patrol, checkpoint.patrol, batch, progress)
    checkpoint.reading = await applyReadings(groups.reading, checkpoint.reading, progress)
    checkpoint.leak = await applyLeaks(groups.leak, checkpoint.leak, batch, progress)
    checkpoint.isolation = await applyIsolations(groups.isolation, checkpoint.isolation, batch, progress)
    await db.syncBatches.update(batchId, {
      checkpoint,
      applied,
      state: '已完成',
      errorMessage: '',
      updatedAt: Date.now()
    })
    return (await db.syncBatches.get(batchId)) as SyncBatchRow
  } catch (err) {
    // 检查点已随每条写入持久化；置失败态，等待从检查点重试
    await db.syncBatches.update(batchId, {
      state: '失败',
      errorMessage: err instanceof Error ? err.message : '写入失败',
      updatedAt: Date.now()
    })
    throw err
  }
}

async function applyPatrols(diffs: ReconcileDiff[], from: number, batch: SyncBatchRow, progress: Progress): Promise<number> {
  let index = from
  const cursor = { patrol: from, reading: 0, leak: 0, isolation: 0 }
  const tick = async (): Promise<void> => {
    cursor.patrol = index + 1
    await progress(1, cursor)
  }
  for (; index < diffs.length; index += 1) {
    const diff = diffs[index]
    if (diff.kind === 'identical') continue
    const incoming = diff.incoming as PatrolRow
    if (diff.kind === 'new') {
      const now = Date.now()
      await db.patrols.put({ ...incoming, createdAt: incoming.createdAt ?? now, updatedAt: now })
      await tick()
      continue
    }
    if (diff.kind === 'conflict') {
      await recordConflict(batch, diff)
      await tick()
      continue
    }
    const owned =
      batch.origin === 'field' ? pickOwned(incoming, PATROL_FIELD_KEYS) : pickOwned(incoming, PATROL_DUTY_KEYS)
    await db.patrols.update(diff.localId, { ...owned, updatedAt: Date.now() })
    await tick()
  }
  return index
}

async function applyReadings(diffs: ReconcileDiff[], from: number, progress: Progress): Promise<number> {
  let index = from
  const cursor = { patrol: 0, reading: from, leak: 0, isolation: 0 }
  const tick = async (): Promise<void> => {
    cursor.reading = index + 1
    await progress(1, cursor)
  }
  for (; index < diffs.length; index += 1) {
    const diff = diffs[index]
    if (diff.kind === 'identical') continue
    const incoming = diff.incoming as ReadingRow
    if (diff.kind === 'new') {
      const now = Date.now()
      await db.readings.put({ ...incoming, createdAt: incoming.createdAt ?? now, updatedAt: now })
      await tick()
      continue
    }
    // 读数统一由现场产生；自然键（巡检+点位）重复时覆盖，绝不新增
    const local = (await db.readings.get(diff.localId)) as ReadingRow
    const owned = pickOwned(incoming, READING_FIELD_KEYS)
    await db.readings.update(local.id, { ...owned, updatedAt: Date.now() })
    await tick()
  }
  return index
}

async function applyLeaks(diffs: ReconcileDiff[], from: number, batch: SyncBatchRow, progress: Progress): Promise<number> {
  let index = from
  const cursor = { patrol: 0, reading: 0, leak: from, isolation: 0 }
  const tick = async (): Promise<void> => {
    cursor.leak = index + 1
    await progress(1, cursor)
  }
  for (; index < diffs.length; index += 1) {
    const diff = diffs[index]
    if (diff.kind === 'identical' || diff.kind === 'legacy') continue
    const incoming = diff.incoming as LeakRow
    if (diff.kind === 'conflict') {
      // 同一泄漏单开两遍：两边都留，入冲突队列人工合并
      await keepBothLeaks(batch, diff)
      await tick()
      continue
    }
    if (diff.kind === 'new') {
      const now = Date.now()
      // 幂等兜底：自然键（设备+发现时间）已存在则不新增
      const sameDevice = await db.leaks.where('deviceId').equals(incoming.deviceId).toArray()
      if (sameDevice.some((row) => leakNaturalKey(row) === leakNaturalKey(incoming))) {
        continue
      }
      await db.leaks.put({
        ...incoming,
        importPackageId: batch.packageId,
        dupOf: '',
        needsReview: false,
        createdAt: incoming.createdAt ?? now,
        updatedAt: now
      })
      await tick()
      continue
    }
    // 更新：仅合并归属字段，不覆盖对方侧
    const owned = batch.origin === 'field' ? pickOwned(incoming, LEAK_FIELD_KEYS) : pickOwned(incoming, LEAK_DUTY_KEYS)
    await db.leaks.update(diff.localId, { ...owned, updatedAt: Date.now() })
    await tick()
  }
  return index
}

async function applyIsolations(diffs: ReconcileDiff[], from: number, batch: SyncBatchRow, progress: Progress): Promise<number> {
  let index = from
  const cursor = { patrol: 0, reading: 0, leak: 0, isolation: from }
  const tick = async (): Promise<void> => {
    cursor.isolation = index + 1
    await progress(1, cursor)
  }
  for (; index < diffs.length; index += 1) {
    const diff = diffs[index]
    if (diff.kind === 'identical') continue
    const incoming = diff.incoming as IsolationRow
    if (diff.kind === 'conflict') {
      await keepBothIsolations(batch, diff)
      await tick()
      continue
    }
    if (diff.kind === 'new') {
      const now = Date.now()
      await db.isolationTickets.put({
        ...incoming,
        importPackageId: batch.packageId,
        dupOf: '',
        needsReview: false,
        createdAt: incoming.createdAt ?? now,
        updatedAt: now
      })
      await tick()
      continue
    }
    const owned = batch.origin === 'field' ? pickOwned(incoming, ISO_FIELD_KEYS) : pickOwned(incoming, ISO_DUTY_KEYS)
    await db.isolationTickets.update(diff.localId, { ...owned, updatedAt: Date.now() })
    await tick()
  }
  return index
}

/** 泄漏单冲突：库内原件保留，来包单据作为副本入库，互相标记 dupOf，两边都留 */
async function keepBothLeaks(batch: SyncBatch, diff: ReconcileDiff): Promise<void> {
  const incoming = diff.incoming as LeakRow
  const now = Date.now()
  await db.leaks.put({
    ...incoming,
    id: incoming.id,
    importPackageId: batch.packageId,
    dupOf: diff.localId,
    needsReview: true,
    createdAt: incoming.createdAt ?? now,
    updatedAt: now
  })
  await db.leaks.update(diff.localId, { dupOf: incoming.id, updatedAt: now })
  await recordConflict(batch, diff, incoming.id)
}

async function keepBothIsolations(batch: SyncBatch, diff: ReconcileDiff): Promise<void> {
  const incoming = diff.incoming as IsolationRow
  const now = Date.now()
  await db.isolationTickets.put({
    ...incoming,
    id: incoming.id,
    importPackageId: batch.packageId,
    dupOf: diff.localId,
    needsReview: true,
    createdAt: incoming.createdAt ?? now,
    updatedAt: now
  })
  await db.isolationTickets.update(diff.localId, { dupOf: incoming.id, updatedAt: now })
  await recordConflict(batch, diff, incoming.id)
}

async function recordConflict(batch: SyncBatch, diff: ReconcileDiff, duplicateRowId = diff.incomingId): Promise<void> {
  const exists = await db.syncConflicts.where('naturalKey').equals(diff.naturalKey).first()
  if (exists) return
  const now = Date.now()
  const row: SyncConflictRow = {
    id: createId('cf'),
    batchId: batch.id,
    packageId: batch.packageId,
    entity: diff.entity,
    naturalKey: diff.naturalKey,
    incomingId: diff.incomingId,
    localId: diff.localId,
    duplicateRowId,
    summary: diff.summary,
    resolution: 'keep-both',
    note: '导入对账发现重复开单，系统默认两边都留，待人工合并',
    createdAt: now,
    updatedAt: now,
    revision: 3
  }
  await db.syncConflicts.put(row)
}

/** 人工确认旧包泄漏单：补登但标记 needsReview，等待补隔离范围/复检放行字段 */
export async function admitLegacyLeak(batchId: string, diff: ReconcileDiff): Promise<void> {
  const batch = await db.syncBatches.get(batchId)
  if (!batch) return
  const incoming = diff.incoming as LeakRow
  const now = Date.now()
  const sameDevice = await db.leaks.where('deviceId').equals(incoming.deviceId).toArray()
  if (!sameDevice.some((row) => leakNaturalKey(row) === leakNaturalKey(incoming))) {
    await db.leaks.put({
      ...incoming,
      importPackageId: batch.packageId,
      dupOf: '',
      needsReview: true,
      createdAt: incoming.createdAt ?? now,
      updatedAt: now
    })
  }
  await db.syncBatches.update(batchId, { updatedAt: now })
}

export async function removeBatch(batchId: string): Promise<void> {
  await db.transaction('rw', [db.syncBatches, db.syncConflicts], async () => {
    await db.syncConflicts.where('batchId').equals(batchId).delete()
    await db.syncBatches.delete(batchId)
  })
}
