/**
 * /sync 回传对账中心（夜间抢修现场组 ↔ 值班室）
 * - 回传包导出：现场 / 值班各自打包本侧数据
 * - 导入先对账：展示新增 / 合并 / 一致 / 冲突四类结论，确认后按检查点逐条写入
 * - 写入失败从检查点重试；重复包幂等（重复导入不新增泄漏单）
 * - 冲突两边都留，人工裁定保留本地或采用回传
 * - 旧包缺少隔离字段时整体转人工确认队列
 */
import { useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import StatBadge from '@/components/common/StatBadge'
import EmptyPanel from '@/components/common/EmptyPanel'
import SideTag from '@/components/common/SideTag'
import { useStationStore } from '@/stores/stationStore'
import { useSyncStore } from '@/stores/syncStore'
import { SYNC_ORIGIN_LABEL, type SyncOrigin, type SyncPackage } from '@/types/sync'
import type { FieldDiff, ImportLedgerRow, ManualQueueEntry, ReconcileItem, ReconcileReport } from '@/types/reconcile'
import {
  applyPackage,
  buildSyncPackage,
  confirmLegacyPackage,
  ignoreLegacyPackage,
  resolveConflict,
  stageImport,
  type ApplyResult
} from '@/utils/sync'
import { exportBackupJson } from '@/utils/export'
import { RECONCILE_ACTION_LABEL } from '@/types/reconcile'

const ACTION_COLOR: Record<ReconcileItem['action'], 'green' | 'blue' | 'gray' | 'red'> = {
  create: 'green',
  update: 'blue',
  skip: 'gray',
  conflict: 'red'
}

const KIND_LABEL: Record<ReconcileItem['kind'], string> = {
  leak: '泄漏处置单',
  patrol: '巡检',
  reading: '测点读数',
  isolationTicket: '隔离作业票'
}

const LEDGER_LABEL: Record<ImportLedgerRow['status'], string> = {
  待写入: '待写入',
  写入中: '写入中断',
  已完成: '已完成',
  需人工确认: '需人工确认'
}

interface StagedState {
  pkg: SyncPackage
  report: ReconcileReport
}

export default function SyncCenter() {
  const stationStore = useStationStore()
  const syncStore = useSyncStore()
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [exportOpen, setExportOpen] = useState(false)
  const [exportForm] = Form.useForm<{ origin: SyncOrigin; exportedBy: string; stationId: string; remark: string }>()
  const [staged, setStaged] = useState<StagedState | null>(null)
  const [diffTarget, setDiffTarget] = useState<ReconcileItem | null>(null)
  const [failInject, setFailInject] = useState(false)
  const [busy, setBusy] = useState(false)

  const summary = useMemo(() => {
    if (!staged) return { create: 0, update: 0, skip: 0, conflict: 0 }
    return staged.report.items.reduce<Record<ReconcileItem['action'], number>>(
      (acc, item) => {
        acc[item.action] += 1
        return acc
      },
      { create: 0, update: 0, skip: 0, conflict: 0 }
    )
  }, [staged])

  /* ---------------- 导出回传包 ---------------- */

  const openExport = (): void => {
    exportForm.setFieldsValue({
      origin: 'field',
      exportedBy: '',
      stationId: stationStore.stations[0]?.id ?? '',
      remark: '夜间抢修回传'
    })
    setExportOpen(true)
  }

  const submitExport = async (): Promise<void> => {
    const values = await exportForm.validate().catch(() => null)
    if (!values) return
    const pkg = await buildSyncPackage({
      origin: values.origin,
      exportedBy: values.exportedBy,
      remark: values.remark,
      stationId: values.stationId
    })
    exportBackupJson(pkg)
    Message.success(`已生成${SYNC_ORIGIN_LABEL[values.origin]}回传包（编号 ${pkg.packageId.slice(-6)}），可交另一方导入对账`)
    setExportOpen(false)
  }

  /* ---------------- 导入对账 ---------------- */

  const pickFile = (): void => {
    fileRef.current?.click()
  }

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const content = await file.text()
    const outcome = await stageImport(content)
    if (outcome.kind === 'invalid') {
      Message.error(outcome.message)
      return
    }
    if (outcome.kind === 'duplicate') {
      Message.info(`该回传包已完成导入（编号 ${outcome.ledger.packageId.slice(-6)}），重复导入不新增任何泄漏单`)
      return
    }
    if (outcome.kind === 'resumed') {
      Message.info('检测到上次写入中断，已从检查点恢复对账结果，可直接继续写入')
      setStaged({ pkg: outcome.pkg, report: outcome.report })
      return
    }
    if (outcome.kind === 'legacy') {
      Message.warning(`旧版回传包缺少隔离作业票字段，已转人工确认队列（${outcome.entry.preview.leaks} 张泄漏单待确认）`)
      return
    }
    const conflictCount = outcome.report.items.filter((item) => item.action === 'conflict').length
    setStaged({ pkg: outcome.pkg, report: outcome.report })
    Message.info(`对账完成：${outcome.report.items.length} 条，其中冲突 ${conflictCount} 条（冲突两边都留，需人工裁定）`)
  }

  // 断点续传时重新选择同一回传包：stageImport 命中台账后返回检查点，已写入条目自动跳过

  const writePackage = async (): Promise<void> => {
    if (!staged) return
    setBusy(true)
    const firstConflictIndex = staged.report.items.findIndex((item) => item.action === 'conflict')
    const result: ApplyResult = await applyPackage(staged.pkg, {
      failAtIndex: failInject ? Math.max(0, Math.min(2, staged.report.items.length - 1)) : undefined
    })
    setBusy(false)
    if (failInject) setFailInject(false)
    if (result.failed) {
      Message.error(`写入在第 ${result.failedIndex + 1} 条中断：${result.error}；已写入 ${result.applied} 条，点击「从检查点重试」续传`)
    } else {
      Message.success(
        `写入完成：新增 ${result.created} · 合并 ${result.updated} · 冲突挂起 ${result.conflicts} · 一致跳过 ${result.skipped}`
      )
      if (firstConflictIndex >= 0) Message.info('冲突条目已两边留存，请在下方冲突列表裁定')
      setStaged(null)
    }
  }

  const resumeLedger = async (_ledger: ImportLedgerRow): Promise<void> => {
    Message.info('请重新选择该回传包原始文件，系统识别包编号后自动从检查点继续（已写入条目不会重复）')
    fileRef.current?.click()
  }

  /* ---------------- 冲突与人工队列 ---------------- */

  const decideConflict = async (id: string, winner: 'local' | 'incoming'): Promise<void> => {
    await resolveConflict(id, winner, '值班长')
    Message.success(winner === 'local' ? '已保留本地版本，冲突关闭' : '已采用回传版本覆盖冲突字段，冲突关闭')
    setDiffTarget(null)
  }

  const confirmLegacy = async (entry: ManualQueueEntry): Promise<void> => {
    const result = await confirmLegacyPackage(entry.id, '值班长')
    if ('failed' in result && result.failed) {
      Message.error(result.error)
      return
    }
    Message.success('旧包已人工确认并完成导入，隔离安排以现场既有记录为准')
  }

  const reportColumns: TableColumnProps<ReconcileItem>[] = [
    { title: '类型', width: 110, render: (_v, record) => KIND_LABEL[record.kind] },
    { title: '条目', render: (_v, record) => record.title },
    {
      title: '结论',
      width: 110,
      render: (_v, record) => <Tag color={ACTION_COLOR[record.action]}>{RECONCILE_ACTION_LABEL[record.action]}</Tag>
    },
    {
      title: '差异字段',
      width: 260,
      render: (_v, record) =>
        record.diffs.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <Space size={4} wrap>
            {record.diffs.slice(0, 3).map((diff) => (
              <Tag key={diff.field} color="red" size="small">
                {diff.label}
              </Tag>
            ))}
            <Button type="text" size="mini" onClick={() => setDiffTarget(record)}>
              查看两边留痕
            </Button>
          </Space>
        )
    }
  ]

  const ledgerColumns: TableColumnProps<ImportLedgerRow>[] = [
    { title: '包编号', width: 130, render: (_v, record) => record.packageId.slice(-8) },
    { title: '来源', width: 100, render: (_v, record) => SYNC_ORIGIN_LABEL[record.origin] },
    {
      title: '检查点',
      width: 160,
      render: (_v, record) => `${Math.max(0, record.appliedIndex + 1)} / ${record.totalItems}`
    },
    {
      title: '状态',
      width: 110,
      render: (_v, record) => (
        <Tag color={record.status === '已完成' ? 'green' : record.status === '需人工确认' ? 'orange' : 'red'}>
          {LEDGER_LABEL[record.status]}
        </Tag>
      )
    },
    { title: '最近错误', dataIndex: 'lastError', render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 150,
      render: (_v, record) =>
        record.status === '写入中' || record.status === '待写入' ? (
          <Button type="text" size="small" onClick={() => resumeLedger(record)}>
            从检查点重试
          </Button>
        ) : (
          <span className="muted">—</span>
        )
    }
  ]

  const conflictColumns: TableColumnProps<import('@/types/reconcile').ConflictRow>[] = [
    { title: '类型', width: 110, render: (_v, record) => KIND_LABEL[record.kind] },
    { title: '条目', render: (_v, record) => record.title },
    { title: '来源包', width: 130, render: (_v, record) => record.packageId.slice(-8) },
    {
      title: '冲突字段',
      width: 240,
      render: (_v, record) => (
        <Space size={4} wrap>
          {record.diffs.map((diff) => (
            <Tag key={diff.field} color="red" size="small">
              {diff.label}
            </Tag>
          ))}
        </Space>
      )
    },
    {
      title: '状态 / 裁定',
      width: 280,
      render: (_v, record) =>
        record.status === '待裁定' ? (
          <Space size={4}>
            <Button type="text" size="small" onClick={() => setDiffTarget(conflictToItem(record))}>
              查看两边留痕
            </Button>
            <Popconfirm title="保留本地版本，忽略回传值？" onOk={() => decideConflict(record.id, 'local')}>
              <Button type="text" size="small">保留本地</Button>
            </Popconfirm>
            <Popconfirm title="采用回传版本覆盖冲突字段？" onOk={() => decideConflict(record.id, 'incoming')}>
              <Button type="text" size="small" status="success">采用回传</Button>
            </Popconfirm>
          </Space>
        ) : (
          <Tag color={record.status === '已留本地' ? 'gray' : 'blue'}>
            {record.status} · {record.resolvedBy}
          </Tag>
        )
    }
  ]

  const manualColumns: TableColumnProps<ManualQueueEntry>[] = [
    { title: '包编号', width: 130, render: (_v, record) => record.packageId.slice(-8) },
    { title: '来源', width: 100, render: (_v, record) => SYNC_ORIGIN_LABEL[record.origin] },
    {
      title: '包内数据',
      width: 220,
      render: (_v, record) =>
        `泄漏单 ${record.preview.leaks} · 巡检 ${record.preview.patrols} · 读数 ${record.preview.readings} · 隔离票 ${record.preview.isolationTickets}`
    },
    { title: '转人工原因', render: (_v, record) => record.reason },
    {
      title: '操作',
      width: 200,
      render: (_v, record) =>
        record.status === '待确认' ? (
          <Space size={4}>
            <Popconfirm title="确认知悉隔离字段缺失，按现场既有隔离安排导入？" onOk={() => confirmLegacy(record)}>
              <Button type="text" size="small" status="success">
                确认导入
              </Button>
            </Popconfirm>
            <Popconfirm title="忽略该旧包？包体将从队列清除" onOk={() => ignoreLegacyPackage(record.id, '值班长')}>
              <Button type="text" size="small" status="danger">
                忽略
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <Tag color={record.status === '已确认导入' ? 'green' : 'gray'}>
            {record.status}
            {record.decidedBy ? ` · ${record.decidedBy}` : ''}
          </Tag>
        )
    }
  ]

  const pendingConflicts = syncStore.pendingConflicts()
  const pendingManual = syncStore.pendingManual()
  const resumable = syncStore.resumable()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">回传对账中心 · 现场组 ↔ 值班室</h2>
          <p className="page-head__desc">
            导入先对账，冲突两边都留；写入失败从检查点重试；同包重复导入不新增泄漏单；旧包缺隔离字段转人工确认。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={openExport}>生成回传包</Button>
          <Button type="primary" onClick={pickFile}>
            导入回传包对账
          </Button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} />
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="待裁定冲突" value={pendingConflicts.length} suffix="条" tone="danger" />
        <StatBadge label="待人工确认旧包" value={pendingManual.length} suffix="个" tone="warning" />
        <StatBadge label="写入中断（可续传）" value={resumable.length} suffix="个" tone="info" />
        <StatBadge label="累计导入包" value={syncStore.ledger.filter((row) => row.status === '已完成').length} suffix="个" tone="success" />
      </div>

      {staged ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3 className="panel-title" style={{ margin: 0 }}>
              对账预览（来源：{SYNC_ORIGIN_LABEL[staged.pkg.origin]} · {staged.pkg.exportedBy || '未署名'}）
            </h3>
            <Space>
              <Space size={6}>
                <Switch checked={failInject} onChange={setFailInject} size="small" />
                <span className="muted">断点演练（第 3 条写入失败，验证检查点续传）</span>
              </Space>
              <Button onClick={() => setStaged(null)}>取消</Button>
              <Button type="primary" loading={busy} onClick={writePackage}>
                确认写入（{staged.report.items.length} 条）
              </Button>
            </Space>
          </div>
          <Alert
            type={summary.conflict > 0 ? 'warning' : 'info'}
            style={{ margin: '8px 0 12px' }}
            content={
              summary.conflict > 0
                ? `新增 ${summary.create} 条、归属合并 ${summary.update} 条、一致跳过 ${summary.skip} 条；冲突 ${summary.conflict} 条将两边留存并挂起，不在本次自动写入。`
                : `新增 ${summary.create} 条、归属合并 ${summary.update} 条、一致跳过 ${summary.skip} 条，无冲突。`
            }
          />
          <Table<ReconcileItem> rowKey={(record) => `${record.kind}:${record.bizKey}`} size="small" border data={staged.report.items} columns={reportColumns} pagination={false} />
        </div>
      ) : (
        <div className="panel" style={{ marginBottom: 16 }}>
          <EmptyPanel
            title="选择对方回传的 JSON 回传包"
            description="导入后先出对账报告：同设备同日同浓度档位的泄漏单自动归并，不会开两遍。"
            actionText="选择回传包"
            onAction={pickFile}
            compact
          />
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            冲突裁定（本地与回传两边都留）
          </h3>
          <span className="muted">非归属字段不一致才挂冲突；归属方字段已在写入时自动采纳</span>
        </div>
        {syncStore.conflicts.length === 0 ? (
          <EmptyPanel title="暂无冲突" description="两边字段一致或差异均在归属范围内时不会产生冲突。" compact />
        ) : (
          <Table
            rowKey="id"
            size="small"
            border
            data={syncStore.conflicts}
            columns={conflictColumns}
            pagination={false}
          />
        )}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            人工确认队列（旧包缺隔离字段）
          </h3>
          <span className="muted">旧版回传包不含隔离作业票，值班长确认隔离安排后才允许补写</span>
        </div>
        {syncStore.manualQueue.length === 0 ? (
          <EmptyPanel title="暂无待确认旧包" description="v2 回传包均带隔离字段，可直接对账写入。" compact />
        ) : (
          <Table rowKey="id" size="small" border data={syncStore.manualQueue} columns={manualColumns} pagination={false} />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            导入台账与检查点
          </h3>
          <span className="muted">写入逐条提交，中断后重新选择同一回传包即从检查点继续</span>
        </div>
        {syncStore.ledger.length === 0 ? (
          <EmptyPanel title="还没有导入记录" description="导入回传包后在此查看检查点与续传入口。" compact />
        ) : (
          <Table rowKey="id" size="small" border data={syncStore.ledger} columns={ledgerColumns} pagination={false} />
        )}
      </div>

      <Modal
        visible={exportOpen}
        title="生成回传包"
        onCancel={() => setExportOpen(false)}
        onOk={submitExport}
        okText="生成并下载"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={exportForm} layout="vertical">
          <Form.Item field="origin" label="本方角色" rules={[{ required: true }]}>
            <Select
              options={[
                { label: `${SYNC_ORIGIN_LABEL.field}（测点读数 / 处置措施）`, value: 'field' },
                { label: `${SYNC_ORIGIN_LABEL.duty}（隔离范围 / 复检放行）`, value: 'duty' }
              ]}
            />
          </Form.Item>
          <Form.Item field="stationId" label="调压站">
            <Select
              allowClear
              placeholder="不选则导出全部站点"
              options={stationStore.stations.map((station) => ({ label: station.name, value: station.id }))}
            />
          </Form.Item>
          <Form.Item field="exportedBy" label="回传人" rules={[{ required: true, message: '请填写回传人' }]}>
            <Input placeholder="如 张伟 / 值班员王强" />
          </Form.Item>
          <Form.Item field="remark" label="备注">
            <Input placeholder="如 城东调压站夜间抢修回传" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={diffTarget !== null}
        title="冲突两边留痕"
        footer={null}
        onCancel={() => setDiffTarget(null)}
        unmountOnExit
      >
        {diffTarget ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <div>{diffTarget.title}</div>
            <Table<FieldDiff>
              rowKey="field"
              size="small"
              border
              pagination={false}
              data={diffTarget.diffs}
              columns={[
                {
                  title: '字段',
                  width: 150,
                  render: (_v, record) => (
                    <Space size={6}>
                      {record.label}
                      <SideTag owner={record.owner} />
                    </Space>
                  )
                },
                { title: '本地值', render: (_v, record) => String(record.localValue ?? '—') },
                { title: '回传值', render: (_v, record) => String(record.incomingValue ?? '—') }
              ]}
            />
            <Space>
              <Button onClick={() => setDiffTarget(null)}>关闭</Button>
            </Space>
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}

/** 冲突留痕行转对账明细形态，复用差异查看弹窗 */
function conflictToItem(row: import('@/types/reconcile').ConflictRow): ReconcileItem {
  return {
    kind: row.kind,
    bizKey: row.bizKey,
    entityId: row.incomingId,
    localId: row.localId,
    title: row.title,
    action: 'conflict',
    diffs: row.diffs
  }
}
