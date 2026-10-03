/** <SideTag> 字段 / 数据归属标记：现场组（蓝） / 值班室（紫） / 共享（灰） */
import { Tag } from '@arco-design/web-react'
import type { IsolationSide } from '@/types/isolation'
import { SIDE_LABEL } from '@/types/isolation'

export type SideOwner = IsolationSide | 'shared' | 'shared-auto'

const OWNER_COLOR: Record<SideOwner, 'arcoblue' | 'purple' | 'gray'> = {
  field: 'arcoblue',
  duty: 'purple',
  shared: 'gray',
  'shared-auto': 'gray'
}

const OWNER_LABEL: Record<SideOwner, string> = {
  field: SIDE_LABEL.field,
  duty: SIDE_LABEL.duty,
  shared: '双方共享',
  'shared-auto': '共享取值'
}

export default function SideTag({ owner, size = 'small' }: { owner: SideOwner; size?: 'small' | 'medium' }) {
  return (
    <Tag color={OWNER_COLOR[owner]} size={size}>
      {OWNER_LABEL[owner]}
    </Tag>
  )
}
