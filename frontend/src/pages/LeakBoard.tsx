/**
 * /leaks 泄漏处置单与复检闭环（夜间抢修双轨）
 * 现场组：测点读数、处置措施（fieldState）；值班室：隔离范围、复检放行（dutyState）。
 * 两侧各开一份页面各录各的，通过回传包对账合并；重复开单两边都留并标「重复」。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useLeakStore } from '@/stores/leakStore'
import { useIsolationStore, type WorkbenchRole } from '@/stores/isolationStore'
import {
  EMPTY_LEAK_DRAFT,
  LEAK_RETEST_PASS_PPM,
  LEAK_STATES,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'
import {
  ISOLATION_DUTY_STATES,
  ISOLATION_FIELD_STATES,
  isTicketClosed,
  type IsolationTicket
} from '@/types/isolation'
import { formatLeakConcentration } from '@/utils/range'

const ROLE_TEXT: Record<WorkbenchRole, string> = { field: '现场组', duty: '值班室' }

export default function LeakBoard() {
  const stationStore = useStationStore()
  const leakStore = useLeakStore()
  const isolationStore = useIsolationStore()

  const role = isolationStore.role

  const [form] = Form.useForm<LeakDraft>()
  const [fieldForm] = Form.useForm<{ leakTestPpm: number; fieldMeasure: string; fieldHandler: string; leakTestTime: string }>()
  const [scopeForm] = Form.useForm<{ isolationScope: string; dutyHandler: string }>()
  const [retestForm] = Form.useForm<{ retestPpm: number; dutyHandler: string }>()
  const [formOpen, setFormOpen] = useState(false)
  const [fieldOpen, setFieldOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [retestOpen, setRetestOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [target, setTarget] = useState<IsolationTicket | null>(null)
  const [keyword, setKeyword] = useState('')

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'states', label: '处置状态', options: LEAK_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword,
    stationId: leakStore.stationId,
    states: leakStore.stateFilter
  }

  const onModelChange = (next: FilterModel): void => {
    setKeyword(String(next.keyword ?? ''))
    leakStore.patchFilter({
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      stateFilter: (Array.isArray(next.states) ? next.states : []) as LeakState[]
    })
  }

  const rows = leakStore.filteredLeaks().filter((leak) => {
    const text = keyword.trim().toLowerCase()
    if (text.length === 0) return true
    const device = stationStore.devices.find((item) => item.id === leak.deviceId)
    return (
      (device ? device.model.toLowerCase().includes(text) || device.serialNo.toLowerCase().includes(text) : false) ||
      leak.handler.toLowerCase().includes(text) ||
      leak.measure.toLowerCase().includes(text)
    )
  })

  const deviceOptions = stationStore.devices.map((device) => {
    const station = stationStore.stations.find((item) => item.id === device.stationId)
    return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
  })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    setEditingId(null)
    form.setFieldsValue({ ...EMPTY_LEAK_DRAFT, deviceId: deviceOptions[0].value, foundTime: new Date().toISOString().slice(0, 10) })
    setFormOpen(true)
  }

  const openEdit = (leak: Leak): void => {
    setEditingId(leak.id)
    form.setFieldsValue({
      deviceId: leak.deviceId,
      concentrationPpm: leak.concentrationPpm,
      foundTime: leak.foundTime,
      measure: leak.measure,
      state: leak.state,
      retestValuePpm: leak.retestValuePpm,
      handler: leak.handler
    })
    setFormOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values) return
    if (editingId) {
      await leakStore.updateLeak(editingId, values)
      Message.success('处置单已更新')
    } else {
      await leakStore.createLeak(values)
      Message.success('处置单已创建')
    }
    setFormOpen(false)
  }

  const remove = async (leak: Leak): Promise<void> => {
    await leakStore.removeLeak(leak.id)
    Message.success('处置单已删除')
  }

  /** 找到泄漏单对应的隔离票（取非重复副本中最新一张） */
  const ticketOf = (leak: Leak): IsolationTicket | undefined => isolationStore.ticketOfLeak(leak.id)

  const ensureTicket = async (leak: Leak): Promise<IsolationTicket | null> => {
    const existing = ticketOf(leak)
    if (existing) return existing
    const created = await isolationStore.createTicket({ leakId: leak.id, deviceId: leak.deviceId, stationId: leak.stationId })
    Message.success('已开具隔离作业票')
    return created
  }

  /** 现场：录测漏读数与处置措施，推进现场态 */
  const openField = async (leak: Leak): Promise<void> => {
    const ticket = await ensureTicket(leak)
    if (!ticket) return
    setTarget(ticket)
    fieldForm.setFieldsValue({
      leakTestPpm: ticket.leakTestPpm || leak.concentrationPpm,
      fieldMeasure: ticket.fieldMeasure || leak.measure,
      fieldHandler: ticket.fieldHandler || leak.handler,
      leakTestTime: ticket.leakTestTime || new Date().toISOString().slice(0, 16).replace('T', ' ')
    })
    setFieldOpen(true)
  }

  const submitField = async (): Promise<void> => {
    if (!target) return
    const values = await fieldForm.validate().catch(() => null)
    if (!values) return
    await isolationStore.advanceField(target.id, values)
    Message.success('现场测漏读数与处置措施已回传，现场态推进')
    setFieldOpen(false)
  }

  /** 值班：划定隔离范围 */
  const openScope = async (leak: Leak): Promise<void> => {
    const ticket = await ensureTicket(leak)
    if (!ticket) return
    setTarget(ticket)
    scopeForm.setFieldsValue({ isolationScope: ticket.isolationScope, dutyHandler: ticket.dutyHandler })
    setScopeOpen(true)
  }

  const submitScope = async (): Promise<void> => {
    if (!target) return
    const values = await scopeForm.validate().catch(() => null)
    if (!values) return
    await isolationStore.advanceDuty(target.id, values)
    Message.success('隔离范围已划定，值班态推进至「已隔离」')
    setScopeOpen(false)
  }

  /** 值班：复检放行 */
  const openRetest = (ticket: IsolationTicket): void => {
    setTarget(ticket)
    retestForm.setFieldsValue({ retestPpm: ticket.retestPpm || 0, dutyHandler: ticket.dutyHandler })
    setRetestOpen(true)
  }

  const submitRetest = async (): Promise<void> => {
    if (!target) return
    const values = await retestForm.validate().catch(() => null)
    if (!values) return
    try {
      await isolationStore.advanceDuty(target.id, { retestPpm: values.retestPpm, dutyHandler: values.dutyHandler })
      Message.success(`复检 ${values.retestPpm} ppm ≤ ${LEAK_RETEST_PASS_PPM} ppm，值班室已放行，作业票闭环`)
      setRetestOpen(false)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '复检放行失败')
    }
  }

  const fieldTagColor = (s: IsolationTicket['fieldState']): string =>
    s === '待复检' ? 'orange' : s === '已处置' ? 'arcoblue' : 'gray'
  const dutyTagColor = (s: IsolationTicket['dutyState']): string =>
    s === '已放行' ? 'green' : s === '已隔离' ? 'purple' : 'gray'

  const columns: TableColumnProps<Leak>[] = [
    {
      title: '调压站 / 设备',
      width: 220,
      render: (_value, record) => {
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '泄漏浓度',
      width: 110,
      render: (_value, record) => <span style={{ color: '#f53f3f', fontWeight: 600 }}>{formatLeakConcentration(record.concentrationPpm)}</span>
    },
    { title: '发现时间', dataIndex: 'foundTime', width: 110 },
    {
      title: '现场轨（测漏/处置）',
      width: 200,
      render: (_value, record) => {
        const ticket = ticketOf(record)
        if (!ticket) return <span className="muted">未开作业票</span>
        return (
          <Space direction="vertical" size={2}>
            <Tag color={fieldTagColor(ticket.fieldState)} size="small">
              现场·{ticket.fieldState}
            </Tag>
            <span className="muted" style={{ fontSize: 12 }}>
              {ticket.fieldHandler || '未署名'} · {formatLeakConcentration(ticket.leakTestPpm)}
            </span>
          </Space>
        )
      }
    },
    {
      title: '值班轨（隔离/放行）',
      width: 200,
      render: (_value, record) => {
        const ticket = ticketOf(record)
        if (!ticket) return <span className="muted">未开作业票</span>
        return (
          <Space direction="vertical" size={2}>
            <Tag color={dutyTagColor(ticket.dutyState)} size="small">
              值班·{ticket.dutyState}
            </Tag>
            <span className="muted" style={{ fontSize: 12 }}>
              {ticket.isolationScope ? '隔离范围已划定' : '隔离范围待划定'}
              {isTicketClosed(ticket) ? ' · 已闭环' : ''}
            </span>
          </Space>
        )
      }
    },
    {
      title: '标记',
      width: 150,
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.needsReview ? <Tag color="orangered" size="small">待人工确认</Tag> : null}
          {record.dupOf ? <Tag color="red" size="small">重复开单</Tag> : null}
          {record.importPackageId ? <Tag color="arcoblue" size="small">回传导入</Tag> : null}
        </Space>
      )
    },
    {
      title: '操作',
      width: 270,
      render: (_value, record) => {
        const ticket = ticketOf(record)
        const closed = ticket ? isTicketClosed(ticket) : false
        return (
          <Space size={4} wrap>
            {role === 'field' ? (
              <Button type="text" size="small" disabled={closed} onClick={() => openField(record)}>
                现场录测漏/处置
              </Button>
            ) : (
              <>
                <Button type="text" size="small" disabled={closed || (ticket?.dutyState !== '待划定')} onClick={() => openScope(record)}>
                  划定隔离范围
                </Button>
                <Button
                  type="text"
                  size="small"
                  disabled={closed || !ticket || ticket.dutyState !== '已隔离'}
                  onClick={() => ticket && openRetest(ticket)}
                >
                  复检放行
                </Button>
              </>
            )}
            <Button type="text" size="small" onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Popconfirm title="确认删除该处置单？" onOk={() => remove(record)}>
              <Button type="text" size="small" status="danger">
                删除
              </Button>
            </Popconfirm>
          </Space>
        )
      }
    }
  ]

  const stats = leakStore.counts()
  const ticketRows = isolationStore.tickets

  const ticketColumns: TableColumnProps<IsolationTicket>[] = [
    { title: '作业票号', dataIndex: 'ticketNo', width: 180 },
    {
      title: '设备',
      width: 180,
      render: (_v, r) => {
        const device = stationStore.devices.find((item) => item.id === r.deviceId)
        return device ? `${device.type} ${device.model}` : '—'
      }
    },
    {
      title: '现场态（测漏读数/处置措施）',
      width: 260,
      render: (_v, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={fieldTagColor(r.fieldState)} size="small">
            {r.fieldState}
          </Tag>
          <span className="muted" style={{ fontSize: 12 }}>
            {formatLeakConcentration(r.leakTestPpm)} · {r.fieldMeasure || '待填处置措施'} · {r.fieldHandler || '—'}
          </span>
        </Space>
      )
    },
    {
      title: '值班态（隔离范围/复检放行）',
      width: 280,
      render: (_v, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={dutyTagColor(r.dutyState)} size="small">
            {r.dutyState}
          </Tag>
          <span className="muted" style={{ fontSize: 12 }}>
            {r.isolationScope || '隔离范围待划定'} · 复检 {r.retestPpm > 0 ? formatLeakConcentration(r.retestPpm) : '—'}
          </span>
        </Space>
      )
    },
    {
      title: '标记',
      width: 150,
      render: (_v, r) => (
        <Space size={4} wrap>
          {isTicketClosed(r) ? <Tag color="green" size="small">已闭环</Tag> : null}
          {r.needsReview ? <Tag color="orangered" size="small">待人工确认</Tag> : null}
          {r.dupOf ? <Tag color="red" size="small">重复</Tag> : null}
        </Space>
      )
    },
    {
      title: '放行时间',
      width: 150,
      render: (_v, r) => r.releasedAt || <span className="muted">—</span>
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">泄漏处置与隔离作业票（双轨）</h2>
          <p className="page-head__desc">
            现场组拥有测点读数与处置措施，值班室拥有隔离范围与复检放行；两侧独立推进，回传包对账合并。
          </p>
        </div>
        <div className="page-head__actions">
          <Radio.Group
            type="button"
            value={role}
            onChange={(value) => isolationStore.setRole(value as WorkbenchRole)}
            options={[
              { label: '现场组页面', value: 'field' },
              { label: '值班室页面', value: 'duty' }
            ]}
          />
          <Button type="primary" onClick={openCreate}>
            新建处置单
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="处置单总数" value={leakStore.leaks.length} suffix="张" tone="primary" />
        <StatBadge label="待处置" value={stats['待处置']} suffix="张" tone="danger" />
        <StatBadge label="作业票" value={ticketRows.length} suffix="张" tone="info" />
        <StatBadge label="复检放行闭环" value={isolationStore.closedCount()} suffix="张" tone="success" />
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            当前：{ROLE_TEXT[role]}作业视图 · 隔离作业票（{ticketRows.length}）
          </h3>
          <span className="muted">
            {role === 'field'
              ? '可写：测漏读数、处置措施；现场态 测漏中 → 已处置 → 待复检'
              : '可写：隔离范围、复检放行；值班态 待划定 → 已隔离 → 已放行'}
          </span>
        </div>
        {ticketRows.length === 0 ? (
          <EmptyPanel title="暂无隔离作业票" description="在下方处置单上点击现场录测漏或划定隔离范围，将自动开具作业票。" compact />
        ) : (
          <Table<IsolationTicket>
            rowKey="id"
            size="small"
            border
            data={ticketRows}
            columns={ticketColumns}
            pagination={false}
            scroll={{ x: 1300 }}
          />
        )}
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索设备型号 / 编号 / 处置人" onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            处置单清单（{rows.length} / {leakStore.leaks.length}）
          </h3>
          <span className="muted">同一设备同日重复开单时两份都保留，并在「标记」列提示</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的处置单"
            description="可在异常分级页对浓度异常读数直接派发处置单。"
            actionText="新建处置单"
            secondaryText="重置筛选"
            onAction={openCreate}
            onSecondary={() => leakStore.resetFilter()}
            compact
          />
        ) : (
          <Table<Leak> rowKey="id" size="small" border data={rows} columns={columns} pagination={false} scroll={{ x: 1500 }} />
        )}
      </div>

      <Modal
        visible={formOpen}
        title={editingId ? '编辑处置单' : '新建泄漏处置单'}
        onCancel={() => setFormOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={form} layout="vertical" initialValues={EMPTY_LEAK_DRAFT}>
          <Form.Item field="deviceId" label="泄漏设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="concentrationPpm" label="泄漏浓度(ppm)" rules={[{ required: true, message: '请填写浓度' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="foundTime" label="发现时间" rules={[{ required: true, message: '请填写发现时间' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="measure" label="处置措施（现场字段）">
            <Input.TextArea placeholder="如 更换阀体密封垫并做气密试验" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item field="handler" label="处置人（现场字段）">
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="state" label="处置状态（值班字段）" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={LEAK_STATES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="retestValuePpm" label="复检浓度(ppm)（值班字段）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={fieldOpen}
        title="现场组 · 录测漏读数与处置措施"
        onCancel={() => setFieldOpen(false)}
        onOk={submitField}
        okText="保存并推进现场态"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={fieldForm} layout="vertical">
          <Form.Item field="leakTestPpm" label="测漏读数(ppm)" rules={[{ required: true, message: '请填写测漏读数' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="fieldMeasure" label="处置措施" rules={[{ required: true, message: '请填写处置措施' }]}>
            <Input.TextArea placeholder="如 紧固法兰、更换密封垫" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
          <Form.Item field="fieldHandler" label="现场作业人" rules={[{ required: true, message: '请填写作业人' }]}>
            <Input placeholder="如 赵磊" />
          </Form.Item>
          <Form.Item field="leakTestTime" label="测漏时间">
            <Input placeholder="YYYY-MM-DD HH:mm" />
          </Form.Item>
          <div className="muted">现场态：{ISOLATION_FIELD_STATES.join(' → ')}，完成后交值班室复检放行。</div>
        </Form>
      </Modal>

      <Modal
        visible={scopeOpen}
        title="值班室 · 划定隔离范围"
        onCancel={() => setScopeOpen(false)}
        onOk={submitScope}
        okText="确认隔离"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={scopeForm} layout="vertical">
          <Form.Item field="isolationScope" label="隔离范围" rules={[{ required: true, message: '请填写隔离范围' }]}>
            <Input.TextArea placeholder="如 1# 调压器进出口双阀之间管段，关闭进出口球阀并放散" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
          <Form.Item field="dutyHandler" label="值班负责人" rules={[{ required: true, message: '请填写负责人' }]}>
            <Input placeholder="如 孙倩" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={retestOpen}
        title="值班室 · 复检放行"
        onCancel={() => setRetestOpen(false)}
        onOk={submitRetest}
        okText="复检合格并放行"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={retestForm} layout="vertical">
          <Form.Item
            field="retestPpm"
            label={`复检浓度(ppm)，≤ ${LEAK_RETEST_PASS_PPM} 才允许放行`}
            rules={[{ required: true, message: '请填写复检浓度' }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="dutyHandler" label="复检放行值班人" rules={[{ required: true, message: '请填写值班人' }]}>
            <Input placeholder="如 孙倩" />
          </Form.Item>
          <div className="muted">值班态：{ISOLATION_DUTY_STATES.join(' → ')}。</div>
        </Form>
      </Modal>
    </div>
  )
}
