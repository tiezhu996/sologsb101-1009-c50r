/**
 * 入口：先装好 IndexedDB shim，再动态导入验证脚本（避免 ESM import 提升导致 shim 晚于 Dexie）。
 * 运行：npx tsx scripts/idb-shim.ts
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

const g = globalThis as unknown as Record<string, unknown>
g.indexedDB = new IDBFactory()
if (!g.IDBKeyRange) g.IDBKeyRange = IDBKeyRange
if (!g.structuredClone) g.structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

await import('./verify-sync-body.ts')
