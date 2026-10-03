# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、跟踪漏检；**夜间抢修现场组与值班室双线开隔离作业票，回传包先对账后写入（冲突两边都留、检查点续传、旧包转人工确认）**。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22809**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Arco Design 2.66 | 表格、表单、Modal、Tag、Badge、Progress |
| 状态管理 | Zustand 4.5 | `stationStore` / `patrolStore` / `leakStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1009/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbgaspress
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts isolation.ts sync.ts reconcile.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts isolationStore.ts syncStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx SideTag.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx IsolationBoard.tsx SyncCenter.tsx PlanList.tsx
        ├── router/index.tsx
        ├── scripts/            # idb-shim.ts verify-sync-body.ts（npm run verify:sync）
        ├── utils/              # range.ts db.ts export.ts reconcile.ts sync.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、Device | 维护点位上下限/单位/关键点标记（草稿 → 逐条/批量提交并重算历史读数）；按模板批量复制标准值 |
| `/patrols` | 巡检录入 | Patrol、Reading、Point | 选定任务后逐点录入读数，实时偏差率与异常级别；逐点或整批保存；完成巡检、标记漏检、现场备注 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按关键点权重降序排列；勾选批量确认；浓度类点位一键派发泄漏处置单 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 填写处置措施与处置人 → 录入复检浓度判合格闭环；导出处置台账 CSV |
| `/isolations` | 隔离作业票（现场/值班双线） | IsolationTicket、Leak、Device | 一张票两套状态：现场录测点读数与处置措施（隔离待测→测漏中→已处置），值班划定隔离范围与复检放行（待划定→已隔离→已放行） |
| `/sync` | 回传对账中心 | SyncPackage、Conflict、ImportLedger、ManualQueue | 现场/值班各自生成回传包；导入先对账（新增/合并/一致/冲突），按检查点逐条写入，冲突两边都留可裁定，旧包缺隔离字段转人工确认 |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`isolationTickets`（业务表）；`importLedger`（回传导入台账/检查点）、`conflicts`（冲突两边留痕）、`manualQueue`（旧包人工确认）
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)`（补 `revision`、回填 `stationId` 冗余列、重算历史读数偏差率）→ `version(3)`（隔离作业票双轨、泄漏单补稳定业务键 `bizKey`、新增三张对账表）的索引变更与 `upgrade()` 迁移
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位 → 6 次巡检 → 11 条读数 → 3 张泄漏处置单 → 3 张隔离作业票的完整链条；播种幂等
- **回传对账口径（`src/utils/reconcile.ts` / `src/utils/sync.ts`）**
  - 稳定业务键：泄漏单 `lk|设备|发现日|浓度档位(10ppm)`，现场与值班各开一张也能归并，**重复导入不新增泄漏单**
  - 字段归属：现场拥有测点读数/处置措施/处置人/复检浓度；值班拥有处置状态/隔离范围/复检放行；归属字段自动采纳，非归属字段两边都改且不一致记冲突，**本地与回传快照两边都留**，人工裁定保留本地或采用回传
  - 检查点：逐条独立事务写入，台账记 `appliedIndex`；写入失败后重新选择同一回传包即从检查点续传，已写条目不重复；同 `packageId` 的已完成包直接判重跳过
  - 旧包：`packageVersion < 2` 或不含 `isolationTickets` 字段的回传包不自动落库，整体进人工确认队列，值班长确认后才补写
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22809
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run verify:sync  # Node + fake-indexeddb 验证回传对账（归并/冲突/检查点/幂等/旧包）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空
