/**
 * 回传包对账（纯函数，可单测）
 *
 * 规则：
 * 1. 归属字段：现场包只携带/覆盖现场字段，值班包只携带/覆盖值班字段。
 * 2. 同 id 行：按归属字段比对，未变化 identical；变化按 field-update / duty-update / both-update 分类。
 * 3. 同自然键但 id 不同：conflict（同一泄漏单两边各开一遍），两边都留。
 * 4. 旧包（packageVersion < 2 或缺少隔离段且含泄漏单）：相关条目标 legacy，整包转人工确认。
 */
import type { Leak } from '@/types/leak'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { IsolationTicket } from '@/types/isolation'
import {
  LEGACY_PACKAGE_VERSION,
  leakNaturalKey,
  isolationNaturalKey,
  type ReconcileDiff,
  type ReconcileReport,
  type ReturnPackage,
  type SyncOrigin
} from '@/types/sync'

/** 现场归属字段（现场组页面可写） */
export const LEAK_FIELD_KEYS = ['measure', 'handler'] as const
/** 值班归属字段（值班室页面可写） */
export const LEAK_DUTY_KEYS = ['state', 'retestValuePpm'] as const

export const PATROL_FIELD_KEYS = ['fieldState', 'fieldMeasure', 'patrolDate', 'patrolman', 'envNote'] as const
export const PATROL_DUTY_KEYS = ['dutyState', 'dutyReleaseNote'] as const

export const READING_FIELD_KEYS = ['value', 'note', 'isAbnormal', 'deviationPct'] as const

export const ISO_FIELD_KEYS = ['fieldState', 'leakTestPpm', 'fieldMeasure', 'fieldHandler', 'leakTestTime'] as const
export const ISO_DUTY_KEYS = ['dutyState', 'isolationScope', 'retestPpm', 'released', 'dutyHandler', 'releasedAt'] as const

/** 判断对象在给定字段集合上是否有差异（undefined 与缺省视为等价） */
export function differsOn<T extends object>(incoming: T, local: T, keys: readonly (keyof T)[]): boolean {
  return keys.some((key) => {
    const a = incoming[key]
    const b = local[key]
    if (a === undefined && (b === undefined || b === '' || b === 0 || b === false)) return false
    return String(a) !== String(b)
  })
}

function summarize(entity: string, incoming: Record<string, unknown>, local?: Record<string, unknown>): string {
  const name = String(incoming.name ?? incoming.ticketNo ?? incoming.foundTime ?? incoming.planDate ?? incoming.id ?? '')
  return local ? `${entity} ${name} 与库内记录字段不一致` : `${entity} ${name} 为新增`
}

export interface ReconcileContext {
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  isolations: IsolationTicket[]
}

/** 是否旧包：格式版本 < 2（无隔离段）；含泄漏单时必须人工确认隔离信息 */
export function isLegacyPackage(pkg: ReturnPackage): boolean {
  if ((pkg.packageVersion ?? LEGACY_PACKAGE_VERSION) < LEGACY_PACKAGE_VERSION + 1) return true
  const hasLeaks = (pkg.leaks?.length ?? 0) > 0
  const hasIsolationSection = Array.isArray(pkg.isolations)
  return hasLeaks && !hasIsolationSection
}

/** 对账主入口 */
export function reconcilePackage(pkg: ReturnPackage, ctx: ReconcileContext): ReconcileReport {
  const origin: SyncOrigin = pkg.origin === 'duty' ? 'duty' : 'field'
  const legacy = isLegacyPackage(pkg)
  const diffs: ReconcileDiff[] = []

  diffs.push(...diffPatrols(pkg.patrols ?? [], ctx.patrols))
  diffs.push(...diffReadings(pkg.readings ?? [], ctx.readings))
  diffs.push(...diffLeaks(pkg.leaks ?? [], ctx.leaks, legacy))
  diffs.push(...diffIsolations(pkg.isolations ?? [], ctx.isolations))

  return {
    packageId: pkg.packageId,
    origin,
    legacy,
    diffs,
    newCount: diffs.filter((d) => d.kind === 'new').length,
    updateCount: diffs.filter((d) => d.kind.endsWith('update')).length,
    identicalCount: diffs.filter((d) => d.kind === 'identical').length,
    conflictCount: diffs.filter((d) => d.kind === 'conflict').length,
    legacyCount: diffs.filter((d) => d.kind === 'legacy').length
  }
}

function diffPatrols(incoming: Patrol[], locals: Patrol[]): ReconcileDiff[] {
  const byId = new Map(locals.map((row) => [row.id, row]))
  return incoming.map((row) => {
    const local = byId.get(row.id)
    if (!local) {
      return { kind: 'new', entity: 'patrol', incomingId: row.id, localId: '', naturalKey: row.id, summary: summarize('巡检', row as unknown as Record<string, unknown>), incoming: row, local: null }
    }
    const fieldChanged = differsOn(row, local, PATROL_FIELD_KEYS)
    const dutyChanged = differsOn(row, local, PATROL_DUTY_KEYS)
    const kind = !fieldChanged && !dutyChanged ? 'identical' : fieldChanged && dutyChanged ? 'both-update' : fieldChanged ? 'field-update' : 'duty-update'
    return { kind, entity: 'patrol', incomingId: row.id, localId: local.id, naturalKey: row.id, summary: summarize('巡检', row as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>), incoming: row, local }
  })
}

function diffReadings(incoming: Reading[], locals: Reading[]): ReconcileDiff[] {
  const byKey = new Map(locals.map((row) => [`${row.patrolId}|${row.pointId}`, row]))
  const byId = new Map(locals.map((row) => [row.id, row]))
  return incoming.map((row) => {
    // 读数自然键：巡检 + 点位（同一点位重复导入覆盖，不新增）
    const local = byId.get(row.id) ?? byKey.get(`${row.patrolId}|${row.pointId}`)
    if (!local) {
      return { kind: 'new', entity: 'reading', incomingId: row.id, localId: '', naturalKey: `${row.patrolId}|${row.pointId}`, summary: summarize('读数', row as unknown as Record<string, unknown>), incoming: row, local: null }
    }
    const changed = differsOn(row, local, READING_FIELD_KEYS)
    return {
      kind: changed ? 'field-update' : 'identical',
      entity: 'reading',
      incomingId: row.id,
      localId: local.id,
      naturalKey: `${row.patrolId}|${row.pointId}`,
      summary: summarize('读数', row as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>),
      incoming: { ...row, id: local.id },
      local
    }
  })
}

function diffLeaks(incoming: Leak[], locals: Leak[], legacy: boolean): ReconcileDiff[] {
  const byId = new Map(locals.map((row) => [row.id, row]))
  const byNatural = new Map(locals.map((row) => [leakNaturalKey(row), row]))
  return incoming.map((row) => {
    const local = byId.get(row.id)
    // 同 id：归属字段比对
    if (local) {
      if (legacy) {
        return legacyDiff('leak', row.id, local.id, leakNaturalKey(row), row, local)
      }
      const fieldChanged = differsOn(row, local, LEAK_FIELD_KEYS)
      const dutyChanged = differsOn(row, local, LEAK_DUTY_KEYS)
      const kind = !fieldChanged && !dutyChanged ? 'identical' : fieldChanged && dutyChanged ? 'both-update' : fieldChanged ? 'field-update' : 'duty-update'
      return { kind, entity: 'leak', incomingId: row.id, localId: local.id, naturalKey: leakNaturalKey(row), summary: summarize('泄漏单', row as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>), incoming: row, local }
    }
    // 旧包优先：缺隔离字段的泄漏单一律转人工确认，不参与自动合并/判重
    if (legacy) {
      return legacyDiff('leak', row.id, byId.get(row.id)?.id ?? '', leakNaturalKey(row), row, byId.get(row.id) ?? null)
    }
    // 不同 id 但自然键相同：同一泄漏单开两遍 → 冲突，两边都留
    const twin = byNatural.get(leakNaturalKey(row))
    if (twin) {
      return {
        kind: 'conflict',
        entity: 'leak',
        incomingId: row.id,
        localId: twin.id,
        naturalKey: leakNaturalKey(row),
        summary: `泄漏单 ${row.foundTime} 浓度 ${row.concentrationPpm}ppm 与库内 ${twin.id} 疑似重复开单（同设备同日）`,
        incoming: row,
        local: twin
      }
    }
    return { kind: 'new', entity: 'leak', incomingId: row.id, localId: '', naturalKey: leakNaturalKey(row), summary: summarize('泄漏单', row as unknown as Record<string, unknown>), incoming: { ...row, importPackageId: undefined }, local: null }
  })
}

function diffIsolations(incoming: IsolationTicket[], locals: IsolationTicket[]): ReconcileDiff[] {
  const byId = new Map(locals.map((row) => [row.id, row]))
  const byLeak = new Map(locals.map((row) => [isolationNaturalKey(row), row]))
  return incoming.map((row) => {
    const local = byId.get(row.id)
    if (local) {
      const fieldChanged = differsOn(row, local, ISO_FIELD_KEYS)
      const dutyChanged = differsOn(row, local, ISO_DUTY_KEYS)
      const kind = !fieldChanged && !dutyChanged ? 'identical' : fieldChanged && dutyChanged ? 'both-update' : fieldChanged ? 'field-update' : 'duty-update'
      return { kind, entity: 'isolation', incomingId: row.id, localId: local.id, naturalKey: isolationNaturalKey(row), summary: summarize('隔离票', row as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>), incoming: row, local }
    }
    // 同一泄漏单的隔离票被开两份 → 冲突两边都留
    const twin = byLeak.get(isolationNaturalKey(row))
    if (twin) {
      return {
        kind: 'conflict',
        entity: 'isolation',
        incomingId: row.id,
        localId: twin.id,
        naturalKey: isolationNaturalKey(row),
        summary: `隔离票 ${row.ticketNo} 与库内 ${twin.ticketNo} 关联同一泄漏单 ${row.leakId}`,
        incoming: row,
        local: twin
      }
    }
    return { kind: 'new', entity: 'isolation', incomingId: row.id, localId: '', naturalKey: isolationNaturalKey(row), summary: summarize('隔离票', row as unknown as Record<string, unknown>), incoming: row, local: null }
  })
}

function legacyDiff(
  entity: ReconcileDiff['entity'],
  incomingId: string,
  localId: string,
  naturalKey: string,
  incoming: unknown,
  local: unknown
): ReconcileDiff {
  return {
    kind: 'legacy',
    entity,
    incomingId,
    localId,
    naturalKey,
    summary: '旧版回传包缺少隔离字段，需值班室人工确认隔离范围与复检放行',
    incoming,
    local
  }
}
