# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、跟踪漏检。

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
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts isolation.ts sync.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts isolationStore.ts syncStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx SyncCenter.tsx PlanList.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts export.ts reconcile.ts sync.ts fixturePackage.ts
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
| `/leaks` | 泄漏处置单与隔离作业票（双轨） | Leak、IsolationTicket、Device、Reading | 现场组/值班室视图切换；现场录测漏读数与处置措施，值班划定隔离范围并复检放行；重复开单/待确认标记 |
| `/sync` | 回传对账与断点续传 | SyncBatch、SyncConflict、Leak、IsolationTicket | 导入回传包先出对账单；冲突两边都留；检查点失败续传；重复导入幂等；旧包转人工确认；可生成演示包 |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`isolationTickets`、`syncBatches`、`syncConflicts`
- **数据结构版本**：`DB_VERSION = 3`
  - v1 → v2：补 `revision`、回填点位/处置单 `stationId` 冗余列、按标准区间重算历史读数
  - v2 → v3：夜间抢修**双轨状态**——巡检/处置拆「现场态 + 值班态」；新增隔离作业票表、回传对账批次表（检查点）与冲突表（两边都留）；旧数据迁移回填现场/值班态
- **双轨状态（现场组 / 值班室各开一份页面）**
  - 巡检包：现场态 `待录入 → 已录读`（测点读数、现场处置），值班态 `待接收 → 已接收 → 已放行`（接收回传、复检放行）
  - 隔离作业票 `isolationTickets`：现场态 `测漏中 → 已处置 → 待复检`（测漏读数、处置措施），值班态 `待划定 → 已隔离 → 已放行`（隔离范围、复检放行，复检 ≤ 50ppm 才放行）；现场态「待复检」且值班态「已放行」判闭环
  - 归属字段合并：现场包只覆盖现场字段，值班包只覆盖值班字段，互不覆盖
- **回传对账（`/sync`，`utils/reconcile.ts` + `utils/sync.ts`）**
  - 导入**先对账**：按 id 与自然键输出新增 / 现场字段更新 / 值班字段更新 / 两侧更新 / 无变化 / 冲突 / 旧包 对账单
  - **冲突两边都留**：同设备同发现时间但不同 id（同一泄漏单被两边各开一遍）时，库内原件与回传副本都保留，互标 `dupOf` 并入冲突队列人工合并
  - **检查点续传**：批次按 patrol/reading/leak/isolation 逐条写入，每条成功即落检查点；失败置「失败」，重试从断点继续，已写入不重复
  - **幂等导入**：同一 `packageId` 复用既有批次；泄漏单按 `deviceId + foundTime` 自然键去重，重复导入不新增
  - **旧包转人工**：`packageVersion < 2` 或含泄漏单但缺 `isolations` 段的包判为旧包，整包「待人工确认」，不自动写库，人工补登并标记 `needsReview`，随后补隔离范围/复检放行
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位 → 6 次巡检（含双轨态）→ 11 条读数 → 3 张泄漏处置单 → 2 张隔离作业票的完整父子孙链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22809
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空
