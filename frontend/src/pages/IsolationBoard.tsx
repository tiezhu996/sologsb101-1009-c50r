/**
 * /isolations 隔离作业票（夜间抢修双线作业）
 * 一套数据两套状态：
 * - 现场组：测点读数（泄漏浓度）与处置措施，状态 隔离待测 → 测漏中 → 已处置
 * - 值班室：隔离范围与复检放行，状态 待划定 → 已隔离 → 已放行
 * 两侧各自开页面录各自字段，互不覆盖；回传对账时按字段归属合并。
 * 消费 IsolationTicket、Leak、Device。
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
import { useIsolationStore } from '@/stores/isolationStore'
import {
  DUTY_ISOLATION_STATES,
  FIELD_ISOLATION_STATES,
  SIDE_LABEL,
  type DutyIsolationState,
  type FieldIsolationState,
  type IsolationTicket,
  type IsolationTicketDraft
} from '@/types/isolation'
import { formatLeakConcentration } from '@/utils/range'

const FIELD_TAG: Record<FieldIsolationState, string> = {
  隔离待测: 'orange',
  测漏中: 'blue',
  已处置: 'green'
}

const DUTY_TAG: Record<DutyIsolationState, string> = {
  待划定: 'gray',
  已隔离: 'blue',
  已放行: 'green'
}

function nowText(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

export default function IsolationBoard() {
  const stationStore = useStationStore()
  const leakStore = useLeakStore()
  const isolationStore = useIsolationStore()

  const [createForm] = Form.useForm<IsolationTicketDraft>()
  const [fieldForm] = Form.useForm<{ pointName: string; valuePpm: number; measuredAt: string; fieldOperator: string; measure: string }>()
  const [dutyForm] = Form.useForm<{ isolationScope: string; isolatedBy: string; approver: string }>()
  const [createOpen, setCreateOpen] = useState(false)
  const [fieldOpen, setFieldOpen] = useState(false)
  const [dutyOpen, setDutyOpen] = useState(false)
  const [target, setTarget] = useState<IsolationTicket | null>(null)
  const [stationId, setStationId] = useState('')
  const [fieldFilter, setFieldFilter] = useState('')
  const [dutyFilter, setDutyFilter] = useState('')

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      {
        key: 'fieldState',
        label: '现场状态',
        multiple: false,
        options: FIELD_ISOLATION_STATES.map((item) => ({ label: item, value: item }))
      },
      {
        key: 'dutyState',
        label: '值班状态',
        multiple: false,
        options: DUTY_ISOLATION_STATES.map((item) => ({ label: item, value: item }))
      }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = { keyword: '', stationId, fieldState: fieldFilter, dutyState: dutyFilter }

  const onModelChange = (next: FilterModel): void => {
    setStationId(typeof next.stationId === 'string' ? next.stationId : '')
    setFieldFilter(typeof next.fieldState === 'string' ? next.fieldState : '')
    setDutyFilter(typeof next.dutyState === 'string' ? next.dutyState : '')
  }

  const rows = isolationStore.filteredTickets(stationId, {
    field: (fieldFilter || undefined) as FieldIsolationState | undefined,
    duty: (dutyFilter || undefined) as DutyIsolationState | undefined
  })

  const deviceLabel = (ticket: IsolationTicket): string => {
    const station = stationStore.stations.find((item) => item.id === ticket.stationId)
    const device = stationStore.devices.find((item) => item.id === ticket.deviceId)
    return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
  }

  const deviceOptions = stationStore.devices.map((device) => {
    const station = stationStore.stations.find((item) => item.id === device.stationId)
    return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
  })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    createForm.setFieldsValue({
      ticketNo: `ISO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(isolationStore.tickets.length + 1).padStart(2, '0')}`,
      deviceId: deviceOptions[0].value,
      stationId: '',
      leakId: ''
    })
    setCreateOpen(true)
  }

  const submitCreate = async (): Promise<void> => {
    const values = await createForm.validate().catch(() => null)
    if (!values) return
    const device = stationStore.devices.find((item) => item.id === values.deviceId)
    await isolationStore.createTicket({
      ticketNo: values.ticketNo,
      deviceId: values.deviceId,
      stationId: values.stationId || (device ? device.stationId : ''),
      leakId: values.leakId || ''
    })
    Message.success('隔离作业票已开立，现场与值班两条作业线分别填写')
    setCreateOpen(false)
  }

  const openField = (ticket: IsolationTicket): void => {
    setTarget(ticket)
    fieldForm.setFieldsValue({
      pointName: ticket.measurePointReadings[0]?.pointName ?? '',
      valuePpm: isolationStore.latestPpm(ticket),
      measuredAt: nowText(),
      fieldOperator: ticket.fieldOperator,
      measure: ticket.measure
    })
    setFieldOpen(true)
  }

  const submitField = async (): Promise<void> => {
    if (!target) return
    const values = await fieldForm.validate().catch(() => null)
    if (!values) return
    await isolationStore.addMeasurePoint(target.id, values.pointName, values.valuePpm, values.measuredAt)
    await isolationStore.patchField(target.id, {
      fieldOperator: values.fieldOperator,
      measure: values.measure,
      fieldState: target.fieldState === '隔离待测' ? '测漏中' : target.fieldState
    })
    Message.success('现场测点读数与处置措施已记录（值班室字段不受影响）')
    setFieldOpen(false)
  }

  const completeField = async (ticket: IsolationTicket): Promise<void> => {
    const next = await isolationStore.advanceField(ticket.id)
    if (next) Message.success(`现场作业线推进为「${next}」`)
  }

  const openDuty = (ticket: IsolationTicket): void => {
    setTarget(ticket)
    dutyForm.setFieldsValue({
      isolationScope: ticket.isolationScope,
      isolatedBy: ticket.isolatedBy,
      approver: ticket.retestApprover
    })
    setDutyOpen(true)
  }

  const submitDutyScope = async (): Promise<void> => {
    if (!target) return
    const values = await dutyForm.validate().catch(() => null)
    if (!values) return
    await isolationStore.patchDuty(target.id, {
      isolationScope: values.isolationScope,
      isolatedBy: values.isolatedBy,
      dutyState: target.dutyState === '待划定' ? '已隔离' : target.dutyState,
      isolatedAt: target.isolatedAt || nowText()
    })
    Message.success('隔离范围已划定并挂牌（现场测点数据不受影响）')
    setDutyOpen(false)
  }

  const approve = async (ticket: IsolationTicket): Promise<void> => {
    if (ticket.fieldState !== '已处置') {
      Message.warning('现场尚未完成处置与测漏，不能复检放行')
      return
    }
    await isolationStore.approveRetest(ticket.id, ticket.retestApprover || '值班长')
    Message.success('复检合格，值班室已放行，作业票闭环')
  }

  const remove = async (ticket: IsolationTicket): Promise<void> => {
    await isolationStore.removeTicket(ticket.id)
    Message.success('作业票已删除')
  }

  const columns: TableColumnProps<IsolationTicket>[] = [
    { title: '票号', dataIndex: 'ticketNo', width: 150 },
    { title: '调压站 / 设备', width: 220, render: (_v, record) => deviceLabel(record) },
    {
      title: '现场组：测点读数与处置',
      width: 300,
      render: (_v, record) => (
        <Space direction="vertical" size={2}>
          <Space size={6}>
            <Tag color={FIELD_TAG[record.fieldState]}>{record.fieldState}</Tag>
            <span style={{ color: '#165dff' }}>
              {record.measurePointReadings.length > 0
                ? `最新 ${formatLeakConcentration(isolationStore.latestPpm(record))} · ${record.measuredAt}`
                : '未录测点'}
            </span>
          </Space>
          <span className="muted">{record.measure ? `措施：${record.measure}` : '处置措施未填'}</span>
          <span className="muted">现场操作人：{record.fieldOperator || '—'}</span>
        </Space>
      )
    },
    {
      title: '值班室：隔离范围与复检放行',
      width: 300,
      render: (_v, record) => (
        <Space direction="vertical" size={2}>
          <Space size={6}>
            <Tag color={DUTY_TAG[record.dutyState]}>{record.dutyState}</Tag>
            {record.retestApproved ? <Tag color="green">已放行 · {record.retestApprover}</Tag> : null}
          </Space>
          <span className="muted">{record.isolationScope ? `隔离：${record.isolationScope}` : '隔离范围未划定'}</span>
          <span className="muted">
            {record.isolatedAt ? `挂牌 ${record.isolatedAt}` : '未挂牌'}
            {record.retestApprovedAt ? ` · 放行 ${record.retestApprovedAt}` : ''}
          </span>
        </Space>
      )
    },
    {
      title: '操作',
      width: 280,
      fixed: 'right',
      render: (_v, record) => (
        <Space size={4} wrap>
          <Button type="text" size="small" onClick={() => openField(record)}>
            现场录测漏
          </Button>
          {record.fieldState !== '已处置' ? (
            <Button type="text" size="small" status="success" onClick={() => completeField(record)}>
              现场处置完成
            </Button>
          ) : null}
          <Button type="text" size="small" onClick={() => openDuty(record)}>
            值班划定隔离
          </Button>
          {record.dutyState === '已隔离' ? (
            <Button type="text" size="small" status="success" onClick={() => approve(record)}>
              复检放行
            </Button>
          ) : null}
          <Popconfirm title="确认删除该作业票？" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const openLeakCount = isolationStore.tickets.filter((ticket) => ticket.dutyState !== '已放行').length
  const fieldDoneCount = isolationStore.tickets.filter((ticket) => ticket.fieldState === '已处置').length
  const releasedCount = isolationStore.tickets.filter((ticket) => ticket.dutyState === '已放行').length

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">隔离作业票 · 现场/值班双线作业</h2>
          <p className="page-head__desc">
            {SIDE_LABEL.field}拥有测点读数与处置措施（隔离待测 → 测漏中 → 已处置）；{SIDE_LABEL.duty}
            拥有隔离范围与复检放行（待划定 → 已隔离 → 已放行）。两侧各开页面，只写本侧字段。
          </p>
        </div>
        <div className="page-head__actions">
          <Button type="primary" onClick={openCreate}>
            新开隔离作业票
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="作业票总数" value={isolationStore.tickets.length} suffix="张" tone="primary" />
        <StatBadge label="现场已处置" value={fieldDoneCount} suffix="张" tone="info" />
        <StatBadge label="未放行" value={openLeakCount} suffix="张" tone="warning" />
        <StatBadge label="复检放行" value={releasedCount} suffix="张" tone="success" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="" syncQuery={false} onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            作业票清单（{rows.length} / {isolationStore.tickets.length}）
          </h3>
          <span className="muted">同一作业票两边并行推进，回传后按字段归属对账，冲突两边都留</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="还没有隔离作业票"
            description="夜间抢修开票后，现场组录测点读数与处置措施，值班室划定隔离范围并复检放行。"
            actionText="新开隔离作业票"
            onAction={openCreate}
            compact
          />
        ) : (
          <Table<IsolationTicket>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1300 }}
          />
        )}
      </div>

      <Modal
        visible={createOpen}
        title="新开隔离作业票"
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        okText="开票"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={createForm} layout="vertical">
          <Form.Item field="ticketNo" label="作业票号" rules={[{ required: true, message: '请填写票号' }]}>
            <Input placeholder="如 ISO-20241003-01" />
          </Form.Item>
          <Form.Item field="deviceId" label="检修设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="leakId" label="关联泄漏处置单（可后补）">
            <Select
              allowClear
              showSearch
              placeholder="选择已派发的泄漏单"
              options={leakStore.leaks
                .filter((leak) => leak.state !== '已复检')
                .map((leak) => {
                  const device = stationStore.devices.find((item) => item.id === leak.deviceId)
                  return { label: `${leak.foundTime} · ${device ? device.model : leak.deviceId} · ${leak.concentrationPpm}ppm`, value: leak.id }
                })}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={fieldOpen}
        title={`现场作业 · ${target?.ticketNo ?? ''}`}
        onCancel={() => setFieldOpen(false)}
        onOk={submitField}
        okText="保存现场记录"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={fieldForm} layout="vertical">
          <Form.Item field="pointName" label="测漏点" rules={[{ required: true, message: '请填写测漏点' }]}>
            <Input placeholder="如 调压器进口法兰" />
          </Form.Item>
          <Form.Item field="valuePpm" label="泄漏浓度(ppm)" rules={[{ required: true, message: '请填写读数' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="measuredAt" label="测量时刻" rules={[{ required: true, message: '请填写测量时刻' }]}>
            <Input placeholder="YYYY-MM-DD HH:mm" />
          </Form.Item>
          <Form.Item field="fieldOperator" label="现场操作人" rules={[{ required: true, message: '请填写操作人' }]}>
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="measure" label="处置措施">
            <Input.TextArea placeholder="如 更换密封垫、紧固法兰后复测" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
        <div className="muted">本表单只写现场字段；隔离范围与放行由值班室在其页面填写。</div>
      </Modal>

      <Modal
        visible={dutyOpen}
        title={`值班作业 · ${target?.ticketNo ?? ''}`}
        onCancel={() => setDutyOpen(false)}
        onOk={submitDutyScope}
        okText="保存隔离安排"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={dutyForm} layout="vertical">
          <Form.Item field="isolationScope" label="隔离范围（关阀 / 泄压 / 挂牌）" rules={[{ required: true, message: '请填写隔离范围' }]}>
            <Input.TextArea placeholder="如 关闭进出口球阀，泄压后挂禁止合闸牌" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item field="isolatedBy" label="隔离签发人" rules={[{ required: true, message: '请填写签发人' }]}>
            <Input placeholder="如 王强" />
          </Form.Item>
          <Form.Item field="approver" label="复检放行批准人">
            <Input placeholder="复检合格放行时署名" />
          </Form.Item>
        </Form>
        <div className="muted">隔离与放行权属值班室；现场测点读数与措施不在此表单内。</div>
      </Modal>
    </div>
  )
}
