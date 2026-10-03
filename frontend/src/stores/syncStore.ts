/**
 * 回传对账状态（Zustand）：导入台账、冲突留痕、人工确认队列三张本地表的响应式只读视图。
 * 具体导入 / 断点续传 / 裁定动作在 utils/sync.ts，store 只负责把结果回流到 UI。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, type ConflictRow, type ImportLedgerRow, type ManualQueueEntry } from '@/utils/db'

interface SyncState_ {
  ledger: ImportLedgerRow[]
  conflicts: ConflictRow[]
  manualQueue: ManualQueueEntry[]
  ready: boolean
  pendingConflicts: () => ConflictRow[]
  pendingManual: () => ManualQueueEntry[]
  resumable: () => ImportLedgerRow[]
}

export const useSyncStore = create<SyncState_>((_set, get) => ({
  ledger: [],
  conflicts: [],
  manualQueue: [],
  ready: false,

  pendingConflicts() {
    return get()
      .conflicts.filter((row) => row.status === '待裁定')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  },

  pendingManual() {
    return get()
      .manualQueue.filter((row) => row.status === '待确认')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  },

  resumable() {
    return get()
      .ledger.filter((row) => row.status === '写入中' || (row.status === '待写入' && row.appliedIndex >= 0))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
}))

liveQuery(async () =>
  (await db.importLedger.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)
).subscribe({
  next: (rows) => useSyncStore.setState({ ledger: rows, ready: true })
})

liveQuery(async () => (await db.conflicts.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)).subscribe({
  next: (rows) => useSyncStore.setState({ conflicts: rows })
})

liveQuery(async () => (await db.manualQueue.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)).subscribe({
  next: (rows) => useSyncStore.setState({ manualQueue: rows })
})
