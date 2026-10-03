/**
 * 回传对账核心流程验证（Node + fake-indexeddb，不依赖浏览器）：
 * 1. 现场/值班两边对同一泄漏各开单 → 回传按业务键归并，不新增
 * 2. 归属字段自动采纳；非归属字段冲突两边都留，本地不动
 * 3. 写入中断 → 从检查点重试，已写入不重复
 * 4. 同一回传包重复导入 → 幂等
 * 5. 旧包缺隔离字段 → 转人工确认，确认后才写入
 * 6. 隔离票双轨字段分属：现场包只动现场字段
 *
 * 运行：npx tsx --import ./scripts/idb-shim.ts scripts/verify-sync.ts
 */
import { db, initDatabase, type IsolationTicketRow, type LeakRow } from '../src/utils/db'
import { applyPackage, buildSyncPackage, confirmLegacyPackage, stageImport } from '../src/utils/sync'
import { buildReconcileReport } from '../src/utils/reconcile'
import { leakBizKeyOf } from '../src/types/leak'
import type { SyncPackage } from '../src/types/sync'

let assertCount = 0
function assert(condition: boolean, message: string): void {
  assertCount += 1
  if (!condition) throw new Error(`断言失败：${message}`)
  console.log(`  ✓ ${message}`)
}

function leak(partial: Partial<LeakRow> & Pick<LeakRow, 'id' | 'deviceId' | 'concentrationPpm' | 'foundTime'>): LeakRow {
  return {
    stationId: 'st-1',
    bizKey: leakBizKeyOf(partial.deviceId, partial.foundTime, partial.concentrationPpm),
    measure: '',
    state: '待处置',
    retestValuePpm: 0,
    handler: '',
    createdAt: 1,
    updatedAt: 1,
    revision: 3,
    ...partial
  }
}

async function run(): Promise<void> {
  await initDatabase()

  console.log('场景 1：两边各开同一泄漏单，回传后不新增')
  await db.leaks.put(leak({ id: 'lk-local', deviceId: 'dv-1', concentrationPpm: 65, foundTime: '2024-10-03' }))
  const beforeCount = await db.leaks.count()

  const dutyPkg: SyncPackage = {
    app: 'gbgaspress-sync',
    packageVersion: 2,
    packageId: 'pkg-dup-test',
    origin: 'duty',
    exportedAt: new Date().toISOString(),
    exportedBy: '王强',
    remark: '夜间抢修',
    leaks: [
      // 不同 id、68ppm 与本地 65ppm 同档位（桶 7）→ 同一业务键
      leak({ id: 'lk-duty', deviceId: 'dv-1', concentrationPpm: 68, foundTime: '2024-10-03', state: '已处置' })
    ],
    patrols: [],
    readings: [],
    isolationTickets: []
  }

  const stage1 = await stageImport(JSON.stringify(dutyPkg))
  assert(stage1.kind === 'ready', `对账应通过（got ${stage1.kind}）`)
  if (stage1.kind === 'ready') {
    assert(stage1.report.items[0].action === 'update', '同业务键不判新增；值班归属 state 合并更新')
    await applyPackage(stage1.pkg)
    assert((await db.leaks.count()) === beforeCount, `泄漏单数量不变（${beforeCount}，同一单不重复开）`)
    assert((await db.leaks.get('lk-local'))?.state === '已处置', '值班归属的处置状态已合并到原单')
  }

  console.log('场景 2：非归属字段冲突两边都留')
  const fieldPkg: SyncPackage = {
    ...dutyPkg,
    packageId: 'pkg-conflict-test',
    origin: 'field',
    leaks: [
      leak({
        id: 'lk-field-x',
        deviceId: 'dv-1',
        concentrationPpm: 66,
        foundTime: '2024-10-03',
        state: '待处置', // 现场改了属值班的 state
        measure: '现场已紧固法兰',
        handler: '张伟'
      })
    ]
  }
  const stage2 = await stageImport(JSON.stringify(fieldPkg))
  if (stage2.kind === 'ready') {
    const item = stage2.report.items[0]
    assert(item.action === 'conflict', '现场改值班归属字段 → 冲突挂起')
    assert(item.diffs.some((d) => d.field === 'state'), '差异含 state 字段')
    await applyPackage(stage2.pkg)
    const conflicts = await db.conflicts.where('packageId').equals('pkg-conflict-test').toArray()
    assert(conflicts.length === 1, '冲突两边都留：conflicts 表 1 条')
    assert(conflicts[0].localSnapshot !== null && conflicts[0].incomingSnapshot !== null, '本地与回传快照均留存')
    assert((await db.leaks.get('lk-local'))?.state === '已处置', '冲突不自动覆盖本地状态')
  }

  console.log('场景 3：写入中断从检查点重试')
  const multiPkg: SyncPackage = {
    app: 'gbgaspress-sync',
    packageVersion: 2,
    packageId: 'pkg-checkpoint-test',
    origin: 'field',
    exportedAt: new Date().toISOString(),
    exportedBy: '张伟',
    remark: '',
    leaks: [
      leak({ id: 'lk-new-1', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 120, foundTime: '2024-10-03' }),
      leak({ id: 'lk-new-2', deviceId: 'dv-3', stationId: 'st-1', concentrationPpm: 200, foundTime: '2024-10-03' }),
      leak({ id: 'lk-new-3', deviceId: 'dv-5', stationId: 'st-2', concentrationPpm: 90, foundTime: '2024-10-03' })
    ],
    patrols: [],
    readings: [],
    isolationTickets: []
  }
  const stage3 = await stageImport(JSON.stringify(multiPkg))
  assert(stage3.kind === 'ready', '多条款包对账通过')
  if (stage3.kind === 'ready') {
    const failResult = await applyPackage(stage3.pkg, { failAtIndex: 1 })
    assert(failResult.failed, '注入第 2 条失败，apply 返回 failed')
    assert(failResult.applied === 1, '检查点前 1 条已写入')
    const ledgerAfterFail = await db.importLedger.where('packageId').equals('pkg-checkpoint-test').first()
    assert(ledgerAfterFail?.appliedIndex === 0, '台账检查点停在下标 0')

    const restage = await stageImport(JSON.stringify(multiPkg))
    assert(restage.kind === 'resumed', '同一包重新导入识别为检查点恢复')
    if (restage.kind === 'resumed') {
      const resumeResult = await applyPackage(restage.pkg)
      assert(!resumeResult.failed, '续传完成无失败')
      const created = await db.leaks
        .where('bizKey')
        .anyOf([
          leakBizKeyOf('dv-2', '2024-10-03', 120),
          leakBizKeyOf('dv-3', '2024-10-03', 200),
          leakBizKeyOf('dv-5', '2024-10-03', 90)
        ])
        .toArray()
      assert(created.length === 3, '三条均落库各仅一条（续传不重复）')
      const done = await db.importLedger.where('packageId').equals('pkg-checkpoint-test').first()
      assert(done?.status === '已完成', '台账状态已完成')
    }
  }

  console.log('场景 4：重复导入已完成的包 → 幂等')
  const totalLeak = await db.leaks.count()
  const again = await stageImport(JSON.stringify(multiPkg))
  assert(again.kind === 'duplicate', '已完成包再次导入返回 duplicate')
  assert((await db.leaks.count()) === totalLeak, '重复导入后泄漏单数量不变')

  console.log('场景 5：旧包缺隔离字段 → 转人工确认')
  const dv4Before = await db.leaks.where('deviceId').equals('dv-4').count()
  const legacyPkg = {
    app: 'gbgaspress-sync',
    packageVersion: 1,
    packageId: 'pkg-legacy-test',
    origin: 'field' as const,
    exportedAt: new Date().toISOString(),
    exportedBy: '张伟',
    remark: '老终端导出',
    leaks: [leak({ id: 'lk-old-1', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 77, foundTime: '2024-10-03' })],
    patrols: [],
    readings: []
  }
  const stage5 = await stageImport(JSON.stringify(legacyPkg))
  assert(stage5.kind === 'legacy', '旧包识别为 legacy')
  if (stage5.kind === 'legacy') {
    assert(stage5.entry.status === '待确认', '旧包进入人工确认队列')
    assert((await db.leaks.where('deviceId').equals('dv-4').count()) === dv4Before, '旧包未自动写入')
    const result = await confirmLegacyPackage(stage5.entry.id, '值班长')
    assert(!('failed' in result) || !result.failed, '人工确认后导入成功')
    assert((await db.manualQueue.get(stage5.entry.id))?.status === '已确认导入', '队列条目为已确认导入')
  }

  console.log('场景 6：隔离票双轨字段分属对账')
  const ticket: IsolationTicketRow = {
    id: 'iso-x',
    ticketNo: 'ISO-X1',
    deviceId: 'dv-1',
    stationId: 'st-1',
    leakId: '',
    fieldState: '测漏中',
    measurePointReadings: [],
    measure: '',
    fieldOperator: '',
    measuredAt: '',
    fieldUpdatedAt: 1,
    dutyState: '待划定',
    isolationScope: '',
    isolatedBy: '',
    isolatedAt: '',
    retestApproved: false,
    retestApprover: '',
    retestApprovedAt: '',
    dutyUpdatedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    revision: 3
  }
  await db.isolationTickets.put(ticket)
  void (await buildSyncPackage({ origin: 'field', exportedBy: 'test', remark: '' }))
  const ctx = {
    leaks: await db.leaks.toArray(),
    patrols: await db.patrols.toArray(),
    readings: await db.readings.toArray(),
    isolationTickets: await db.isolationTickets.toArray()
  }
  const ticketPkg: SyncPackage = {
    app: 'gbgaspress-sync',
    packageVersion: 2,
    packageId: 'pkg-ticket-test',
    origin: 'field',
    exportedAt: new Date().toISOString(),
    exportedBy: '张伟',
    remark: '',
    leaks: [],
    patrols: [],
    readings: [],
    isolationTickets: [
      { ...ticket, id: 'iso-x-remote', fieldState: '已处置', measure: '更换密封垫', fieldOperator: '张伟' }
    ]
  }
  const report6 = buildReconcileReport(ticketPkg, ctx)
  const ticketItem = report6.items.find((item) => item.kind === 'isolationTicket')
  assert(ticketItem?.action === 'update', `现场推进现场字段判 update（got ${ticketItem?.action}）`)
  assert(
    ticketItem?.merged && (ticketItem.merged as IsolationTicketRow).dutyState === '待划定',
    '值班轨字段不被现场包改动'
  )

  await db.close()
  console.log(`\n全部 ${assertCount} 条断言通过 ✅`)
}

run().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
