/**
 * /sync 回传对账与断点续传
 * 现场组与值班室回传包导入：先对账（新增/更新/冲突/旧包）→ 检查点写入（失败续传）。
 * 冲突两边都留并入冲突队列；旧包缺隔离字段转人工确认；重复导入不新增泄漏单。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Upload,
  Steps,
  Alert,
  Input
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import type { UploadItem } from '@arco-design/web-react/es/Upload'
import EmptyPanel from '@/components/common/EmptyPanel'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useSyncStore } from '@/stores/syncStore'
import { useLeakStore } from '@/stores/leakStore'
import { useIsolationStore } from '@/stores/isolationStore'
import type { SyncBatchRow, SyncConflictRow } from '@/utils/db'
import type { ReconcileDiff } from '@/types/sync'
import {
  buildDutyDuplicateLeakPackage,
  buildFieldNewLeakPackage,
  buildLegacyPackage,
  packageJson
} from '@/utils/fixturePackage'
import { download } from '@/utils/export'

const DIFF_TONE: Record<ReconcileDiff['kind'], string> = {
  new: 'green',
  identical: 'gray',
  'field-update': 'arcoblue',
  'duty-update': 'purple',
  'both-update': 'orange',
  conflict: 'red',
  legacy: 'orangered'
}

const DIFF_LABEL: Record<ReconcileDiff['kind'], string> = {
  new: '新增',
  identical: '无变化',
  'field-update': '现场字段更新',
  'duty-update': '值班字段更新',
  'both-update': '两侧更新',
  conflict: '重复冲突',
  legacy: '旧包待确认'
}

export default function SyncCenter() {
  const stationStore = useStationStore()
  const syncStore = useSyncStore()
  const leakStore = useLeakStore()
  const isolationStore = useIsolationStore()
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [resolving, setResolving] = useState<SyncConflictRow | null>(null)
  const [resolveNote, setResolveNote] = useState('')

  const activeBatch = syncStore.batches.find((batch) => batch.id === activeBatchId) ?? null

  const firstDevice = stationStore.devices[0]

  const readFile = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(file)
    })

  const handleImport = async (raw: string, fileName: string): Promise<void> => {
    try {
      const { batch, reused } = await syncStore.importPackageText(raw, fileName)
      setActiveBatchId(batch.id)
      if (reused) {
        Message.info(`回传包 ${batch.packageId} 已导入过，按幂等规则不新增泄漏单；可在原批次上断点续传`)
        return
      }
      if (batch.legacy) {
        Message.warning('旧版回传包缺少隔离字段，已转人工确认队列')
        return
      }
      Message.success(`对账完成：新增 ${batch.report?.newCount ?? 0}、更新 ${batch.report?.updateCount ?? 0}、冲突 ${batch.conflictCount}`)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '回传包解析失败')
    }
  }

  const onUploadChange = async (_fileList: UploadItem[], file: UploadItem): Promise<void> => {
    const origin = file.originFile
    if (!origin) return
    const raw = await readFile(origin as unknown as File)
    await handleImport(raw, origin.name)
  }

  const runBatch = async (batch: SyncBatchRow): Promise<void> => {
    try {
      const done = await syncStore.runBatch(batch.id)
      if (done.state === '已完成') {
        Message.success(`写入完成：共应用 ${done.applied}/${done.total} 条，冲突两边均已保留`)
      }
    } catch (err) {
      Message.error(err instanceof Error ? `写入失败，已保存检查点：${err.message}` : '写入失败，可从检查点重试')
    }
  }

  const downloadFixture = (builder: (stationId: string, deviceId: string) => ReturnPackageShape, name: string): void => {
    if (!firstDevice) {
      Message.warning('请先登记设备')
      return
    }
    const pkg = builder(firstDevice.stationId, firstDevice.id)
    download(name, packageJson(pkg), 'application/json;charset=utf-8')
    Message.success(`已生成演示回传包 ${name}，可直接点击「导入回传包」选择该文件`)
  }

  const admitLegacy = async (batch: SyncBatchRow, diff: ReconcileDiff): Promise<void> => {
    await syncStore.admitLegacy(batch.id, diff.incomingId)
    Message.success('已补登泄漏单并标记待复核，请在泄漏处置页补录隔离范围与复检放行')
  }

  const submitResolve = async (): Promise<void> => {
    if (!resolving) return
    await syncStore.resolveConflict(resolving.id, resolveNote)
    await syncStore.clearRowReview(resolving.entity === 'isolation' ? 'isolation' : 'leak', resolving.duplicateRowId)
    Message.success('冲突已标记为人工合并，两份记录均保留可查')
    setResolving(null)
    setResolveNote('')
  }

  const diffColumns: TableColumnProps<ReconcileDiff>[] = [
    {
      title: '类型',
      width: 130,
      render: (_v, record) => <Tag color={DIFF_TONE[record.kind]}>{DIFF_LABEL[record.kind]}</Tag>
    },
    { title: '对象', dataIndex: 'entity', width: 90 },
    { title: '自然键', dataIndex: 'naturalKey', width: 220 },
    { title: '对账说明', dataIndex: 'summary' },
    {
      title: '处理',
      width: 150,
      render: (_v, record) => {
        if (record.kind === 'legacy' && activeBatch) {
          return (
            <Button type="text" size="small" status="warning" onClick={() => admitLegacy(activeBatch, record)}>
              人工确认补登
            </Button>
          )
        }
        if (record.kind === 'conflict') return <span className="muted">两边都留，见下方冲突队列</span>
        if (record.kind === 'identical') return <span className="muted">自动跳过</span>
        return <span className="muted">随检查点写入</span>
      }
    }
  ]

  const batchColumns: TableColumnProps<SyncBatchRow>[] = [
    { title: '文件 / 包号', width: 260, render: (_v, r) => (
      <div>
        <div style={{ fontWeight: 600 }}>{r.fileName}</div>
        <div className="muted" style={{ fontSize: 12 }}>{r.packageId}</div>
      </div>
    ) },
    { title: '来源', width: 90, render: (_v, r) => <Tag color={r.origin === 'field' ? 'arcoblue' : 'purple'}>{r.origin === 'field' ? '现场组' : '值班室'}</Tag> },
    {
      title: '状态',
      width: 110,
      render: (_v, r) => (
        <Tag color={r.state === '已完成' ? 'green' : r.state === '失败' ? 'red' : r.state === '待人工确认' ? 'orangered' : 'orange'}>
          {r.state}
        </Tag>
      )
    },
    {
      title: '检查点进度',
      width: 150,
      render: (_v, r) => `${r.applied}/${r.total}`
    },
    { title: '冲突', dataIndex: 'conflictCount', width: 70 },
    {
      title: '错误',
      width: 200,
      render: (_v, r) => r.errorMessage || <span className="muted">—</span>
    },
    {
      title: '操作',
      width: 220,
      render: (_v, r) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => setActiveBatchId(r.id)}>
            对账单
          </Button>
          {r.state !== '已完成' && r.state !== '待人工确认' ? (
            <Button type="text" size="small" onClick={() => runBatch(r)}>
              {r.state === '失败' ? '从检查点重试' : '执行写入'}
            </Button>
          ) : null}
          <Popconfirm title="删除该批次及冲突记录（不回滚已写入数据）？" onOk={() => syncStore.discardBatch(r.id)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const conflictColumns: TableColumnProps<SyncConflictRow>[] = [
    { title: '对象', dataIndex: 'entity', width: 90 },
    { title: '自然键', dataIndex: 'naturalKey', width: 220 },
    { title: '库内单', dataIndex: 'localId', width: 160 },
    { title: '回传单', dataIndex: 'incomingId', width: 160 },
    { title: '说明', dataIndex: 'summary' },
    {
      title: '处理',
      width: 130,
      render: (_v, r) => (
        <Button
          type="text"
          size="small"
          onClick={() => {
            setResolving(r)
            setResolveNote(r.note)
          }}
        >
          {r.resolution === 'merge' ? '查看处理' : '人工合并'}
        </Button>
      )
    }
  ]

  const stepIndex = useMemo(() => {
    if (!activeBatch) return 0
    if (activeBatch.state === '待对账') return 0
    if (activeBatch.state === '已对账' || activeBatch.state === '待人工确认') return 1
    if (activeBatch.state === '写入中' || activeBatch.state === '失败') return 2
    return 3
  }, [activeBatch])

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">回传对账与断点续传</h2>
          <p className="page-head__desc">
            现场组 / 值班室各开一份页面录单，回传包先对账再写入；重复泄漏单两边都留，旧包缺隔离字段转人工确认，失败后从检查点续传。
          </p>
        </div>
        <div className="page-head__actions">
          <Space>
            <Button size="small" onClick={() => downloadFixture(buildFieldNewLeakPackage, '现场回传包-新泄漏单.json')}>
              生成现场包
            </Button>
            <Button size="small" onClick={() => downloadFixture(buildDutyDuplicateLeakPackage, '值班回传包-重复开单.json')}>
              生成重复开单包
            </Button>
            <Button size="small" status="warning" onClick={() => downloadFixture(buildLegacyPackage, '旧版回传包-缺隔离.json')}>
              生成旧版包
            </Button>
            <Upload accept="application/json" showUploadList={false} customRequest={() => undefined} onChange={onUploadChange}>
              <Button type="primary">导入回传包</Button>
            </Upload>
          </Space>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="同步批次" value={syncStore.batches.length} suffix="个" tone="primary" />
        <StatBadge label="待写入/失败" value={syncStore.batches.filter((b) => b.state === '失败' || b.state === '写入中' || b.state === '已对账').length} suffix="个" tone="warning" />
        <StatBadge label="重复冲突（两边都留）" value={syncStore.conflicts.length} suffix="条" tone="danger" />
        <StatBadge label="旧包待人工确认" value={leakStore.leaks.filter((l) => l.needsReview).length + isolationStore.pendingReviewCount()} suffix="条" tone="default" />
      </div>

      {activeBatch ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3 className="panel-title" style={{ margin: 0 }}>
              对账单 · {activeBatch.fileName}
            </h3>
            <Space>
              <Tag color={activeBatch.origin === 'field' ? 'arcoblue' : 'purple'}>
                {activeBatch.origin === 'field' ? '现场组回传' : '值班室回传'}
              </Tag>
              <Button size="small" onClick={() => setActiveBatchId(null)}>
                返回批次列表
              </Button>
            </Space>
          </div>

          <Steps current={stepIndex} style={{ margin: '12px 0 16px' }}>
            <Steps.Step title="导入" description="解析回传包" />
            <Steps.Step title="对账" description={`新增 ${activeBatch.report?.newCount ?? 0} / 更新 ${activeBatch.report?.updateCount ?? 0} / 冲突 ${activeBatch.conflictCount}`} />
            <Steps.Step title="检查点写入" description={`${activeBatch.applied}/${activeBatch.total}`} />
            <Steps.Step title="完成" description="冲突两边都留" />
          </Steps>

          {activeBatch.legacy ? (
            <Alert
              type="warning"
              content="该回传包为旧版格式（缺少隔离范围/复检放行字段），不会自动写入泄漏单；请逐条人工确认补登，随后在泄漏处置页补齐隔离信息。"
              style={{ marginBottom: 12 }}
            />
          ) : null}
          {activeBatch.state === '失败' ? (
            <Alert
              type="error"
              style={{ marginBottom: 12 }}
              content={`写入在检查点 ${activeBatch.applied}/${activeBatch.total} 处中断：${activeBatch.errorMessage}；已写入的不会重复，点击「从检查点重试」续传剩余条目。`}
            />
          ) : null}

          <Space style={{ marginBottom: 12 }}>
            {activeBatch.state !== '已完成' && activeBatch.state !== '待人工确认' ? (
              <Button type="primary" status="success" onClick={() => runBatch(activeBatch)}>
                {activeBatch.state === '失败' ? `从检查点重试（${activeBatch.applied}/${activeBatch.total}）` : '执行检查点写入'}
              </Button>
            ) : (
              <Tag color="green" size="large">
                {activeBatch.state === '已完成' ? '该批次已全部写入' : '旧包等待人工确认'}
              </Tag>
            )}
          </Space>

          <Table<ReconcileDiff>
            rowKey={(record) => `${record.entity}-${record.incomingId}-${record.kind}`}
            size="small"
            border
            data={activeBatch.report?.diffs ?? []}
            columns={diffColumns}
            pagination={false}
          />
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            同步批次（{syncStore.batches.length}）
          </h3>
          <span className="muted">同一回传包重复导入直接复用批次，不新增泄漏单</span>
        </div>
        {syncStore.batches.length === 0 ? (
          <EmptyPanel
            title="还没有回传包"
            description="现场组与值班室抢修录单后，各自导出回传包，在此导入对账。可先用上方按钮生成演示包。"
            compact
          />
        ) : (
          <Table<SyncBatchRow> rowKey="id" size="small" border data={syncStore.batches} columns={batchColumns} pagination={false} />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            冲突队列 · 两边都留（{syncStore.conflicts.length}）
          </h3>
          <span className="muted">同一泄漏单/隔离票被两边各开一遍时，库内原件与回传单均保留，标记后人工合并</span>
        </div>
        {syncStore.conflicts.length === 0 ? (
          <EmptyPanel title="暂无重复冲突" description="导入时若发现同设备同日重复开单，会在此列出，两份记录都保留。" compact />
        ) : (
          <Table<SyncConflictRow> rowKey="id" size="small" border data={syncStore.conflicts} columns={conflictColumns} pagination={false} />
        )}
      </div>

      <Modal
        visible={resolving !== null}
        title="人工合并冲突（两份记录均保留）"
        onCancel={() => setResolving(null)}
        onOk={submitResolve}
        okText="确认处理"
        cancelText="取消"
        unmountOnExit
      >
        {resolving ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Alert type="info" content={resolving.summary} />
            <div>
              库内单：<strong>{resolving.localId}</strong>
            </div>
            <div>
              回传单（副本保留）：<strong>{resolving.incomingId}</strong>
            </div>
            <Input.TextArea
              value={resolveNote}
              onChange={setResolveNote}
              placeholder="记录人工合并结论，例如：保留库内单号，副本措施已并入"
              autoSize={{ minRows: 3, maxRows: 5 }}
            />
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}

type ReturnPackageShape = ReturnType<typeof buildFieldNewLeakPackage>
