/**
 * 回传包同步状态（Zustand）
 * 批次检查点、冲突清单、人工确认队列。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, type SyncBatchRow, type SyncConflictRow, type LeakRow } from '@/utils/db'
import {
  admitLegacyLeak,
  applyBatch,
  openImportBatch,
  parseReturnPackage,
  removeBatch
} from '@/utils/sync'
import type { ReturnPackage } from '@/types/sync'

interface SyncState_ {
  batches: SyncBatchRow[]
  conflicts: SyncConflictRow[]
  reviewLeaks: LeakRow[]
  ready: boolean
  /** 导入一份回传包文件文本：先对账，返回批次（旧包转人工确认） */
  importPackageText: (raw: string, fileName: string) => Promise<{ batch: SyncBatchRow; reused: boolean }>
  /** 从检查点执行/续传写入 */
  runBatch: (batchId: string) => Promise<SyncBatchRow>
  retryBatch: (batchId: string) => Promise<SyncBatchRow>
  discardBatch: (batchId: string) => Promise<void>
  /** 人工确认旧包中的一条泄漏单 */
  admitLegacy: (batchId: string, incomingId: string) => Promise<void>
  /** 解决冲突后清除某张泄漏单/隔离票的待复核标记 */
  clearRowReview: (entity: 'leak' | 'isolation', rowId: string) => Promise<void>
  resolveConflict: (conflictId: string, note: string) => Promise<void>
}

export const useSyncStore = create<SyncState_>((_set, get) => ({
  batches: [],
  conflicts: [],
  reviewLeaks: [],
  ready: false,

  async importPackageText(raw, fileName) {
    const pkg: ReturnPackage = parseReturnPackage(raw)
    return openImportBatch(pkg, fileName)
  },

  async runBatch(batchId) {
    return applyBatch(batchId)
  },

  async retryBatch(batchId) {
    return applyBatch(batchId)
  },

  async discardBatch(batchId) {
    await removeBatch(batchId)
  },

  async admitLegacy(batchId, incomingId) {
    const batch = get().batches.find((item) => item.id === batchId)
    const diff = batch?.report?.diffs.find((item) => item.incomingId === incomingId && item.kind === 'legacy')
    if (!diff) return
    await admitLegacyLeak(batchId, diff)
  },

  async clearRowReview(entity, rowId) {
    if (entity === 'leak') {
      await db.leaks.update(rowId, { needsReview: false, updatedAt: Date.now() })
    } else {
      await db.isolationTickets.update(rowId, { needsReview: false, updatedAt: Date.now() })
    }
  },

  async resolveConflict(conflictId, note) {
    await db.syncConflicts.update(conflictId, {
      resolution: 'merge',
      note: note || '人工已处理合并',
      updatedAt: Date.now()
    })
  }
}))

liveQuery(async () => (await db.syncBatches.toArray()).sort((a, b) => b.createdAt - a.createdAt)).subscribe({
  next: (rows) => useSyncStore.setState({ batches: rows, ready: true }),
  error: () => useSyncStore.setState({ ready: true })
})

liveQuery(async () => (await db.syncConflicts.toArray()).sort((a, b) => b.createdAt - a.createdAt)).subscribe({
  next: (rows) => useSyncStore.setState({ conflicts: rows })
})

liveQuery(async () => {
  const rows = await db.leaks.toArray()
  return rows.filter((row) => row.needsReview).sort((a, b) => b.updatedAt - a.updatedAt)
}).subscribe({
  next: (rows) => useSyncStore.setState({ reviewLeaks: rows })
})
