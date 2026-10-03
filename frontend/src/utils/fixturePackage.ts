/**
 * 演示回传包构造：供「回传对账」页生成现场/值班/重复开单/旧版包，
 * 不依赖真实离线设备，便于验证对账、冲突两边都留、检查点续传与旧包人工确认。
 */
import { createId } from '@/utils/db'
import { RETURN_PACKAGE_VERSION, type ReturnPackage, type SyncOrigin } from '@/types/sync'
import type { Leak } from '@/types/leak'
import type { IsolationTicket } from '@/types/isolation'

function nowText(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

function base(origin: SyncOrigin, packageId: string, packageVersion: number): ReturnPackage {
  return {
    app: 'gbgaspress-return',
    packageId,
    origin,
    packagedAt: new Date().toISOString(),
    packageVersion
  }
}

/** 现场回传包：带一张全新泄漏单 + 现场处置读数（新单，首次导入） */
export function buildFieldNewLeakPackage(stationId: string, deviceId: string): ReturnPackage {
  const leakId = createId('lk')
  const today = new Date().toISOString().slice(0, 10)
  const leak: Leak = {
    id: leakId,
    deviceId,
    stationId,
    concentrationPpm: 120,
    foundTime: today,
    measure: '现场紧急紧固卡具，准备更换密封件',
    state: '待处置',
    retestValuePpm: 0,
    handler: '现场-赵磊',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  const isolation: IsolationTicket = {
    id: createId('iso'),
    leakId,
    deviceId,
    stationId,
    ticketNo: `ISO-${today.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    fieldState: '已处置',
    leakTestPpm: 120,
    fieldMeasure: '现场紧急紧固卡具，准备更换密封件',
    fieldHandler: '赵磊',
    leakTestTime: nowText(),
    dutyState: '待划定',
    isolationScope: '',
    retestPpm: 0,
    released: false,
    dutyHandler: '',
    releasedAt: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  return { ...base('field', `pkg-field-new-${Date.now()}`, RETURN_PACKAGE_VERSION), leaks: [leak], isolations: [isolation] }
}

/**
 * 值班重复开单包：同一设备同一天但不同 id（模拟现场与值班室各开一遍），
 * 用于验证冲突两边都留。
 */
export function buildDutyDuplicateLeakPackage(stationId: string, deviceId: string): ReturnPackage {
  const today = new Date().toISOString().slice(0, 10)
  const leak: Leak = {
    id: createId('lk'),
    deviceId,
    stationId,
    concentrationPpm: 118,
    foundTime: today,
    measure: '值班室登记的重复泄漏单',
    state: '待处置',
    retestValuePpm: 0,
    handler: '值班-孙倩',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  const isolation: IsolationTicket = {
    id: createId('iso'),
    leakId: leak.id,
    deviceId,
    stationId,
    ticketNo: `ISO-${today.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    fieldState: '测漏中',
    leakTestPpm: 118,
    fieldMeasure: '',
    fieldHandler: '',
    leakTestTime: '',
    dutyState: '已隔离',
    isolationScope: '值班室划定的隔离范围：进出口双阀之间管段',
    retestPpm: 0,
    released: false,
    dutyHandler: '孙倩',
    releasedAt: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  return { ...base('duty', `pkg-duty-dup-${Date.now()}`, RETURN_PACKAGE_VERSION), leaks: [leak], isolations: [isolation] }
}

/** 旧版回传包（v1，无隔离段）：用于验证缺隔离字段转人工确认 */
export function buildLegacyPackage(stationId: string, deviceId: string): ReturnPackage {
  const today = new Date().toISOString().slice(0, 10)
  const leak: Leak = {
    id: createId('lk'),
    deviceId,
    stationId,
    concentrationPpm: 76,
    foundTime: today,
    measure: '旧版手持终端上报，缺隔离信息',
    state: '待处置',
    retestValuePpm: 0,
    handler: '现场-周凯',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  return { ...base('field', `pkg-legacy-${Date.now()}`, 1), leaks: [leak] }
}

export function packageJson(pkg: ReturnPackage): string {
  return JSON.stringify(pkg, null, 2)
}
