# OpenCode Session Metrics

把 OpenCode 的本机数据库（`~/.local/share/opencode/opencode.db`）物化成一张指标库，
再用一个 Web 面板回看自己的编码会话：跑了哪些会话、花了多少 Token、调用了哪些工具、
每个工具失败过几次、钱花在哪个项目上。

功能范围对齐 [`opencode-top`](https://github.com/kitsuneMori96/opencode-session-metrics/blob/master/docs/opencode-top-parity.md)（Sessions / Tools / Overview
三屏加正文面板），呈现方式按浏览器重排：**一个页面、一条全局切片、图表之间互相下钻**。
窗口、过滤器、对比对象、散点坐标轴都写在 URL 里，链接可以直接发给别人或存进书签。

数据只在本机流转，API 默认绑定 `127.0.0.1`。

## 安装

```bash
npm i -g opencode-holo-cockpit
osm                     # 起服务并打开浏览器
osm status              # 谁在跑、数据在哪
osm logs                # 跟踪服务日志
osm stop                # 停掉后台服务
```

要求 **Node 24+**（使用内置 `node:sqlite`，无原生依赖），且本机已有
`~/.local/share/opencode/opencode.db`。全局安装把指标库写在
`~/.local/share/opencode-holo-cockpit`（`OSM_DATA_DIR` 或 `osm --data` 可改），
升级包不会动到它。`osm run` 前台运行，`--port` / `--host` 改绑定。

从源码运行见[快速开始](#快速开始)。

## 界面

下面的截图取自本机的真实数据，不是合成图；截图为了看清面板用的是 30 天切片（默认窗口是 24 小时）。

### Overview — 总量与形状

KPI 行（各带与上一等长窗口的对比）、按模型堆叠的 Token 时间序列、7×24 活跃热力图、
按小时的轮次分布、会话散点、项目 / 模型 / 工具 / agent 排行、效率面板、最重会话。

![Overview](https://raw.githubusercontent.com/kitsuneMori96/opencode-session-metrics/master/docs/overview.png)

### Sessions — 全部会话一张表

可排序、可展开（根会话下挂子代理会话）；过滤、排序、翻页都由 SQL 完成，
一次取 100 个根会话（连它们的子树），「load more」接着下一段。点一行进详情。

![Sessions](https://raw.githubusercontent.com/kitsuneMori96/opencode-session-metrics/master/docs/sessions.png)

### Session 详情 — 时间线、工具、正文

逐轮 Token、上下文填充、输出 Token 三条曲线与正文面板共享一个游标；框选时间线只留选中的轮次。

![Session 详情](https://raw.githubusercontent.com/kitsuneMori96/opencode-session-metrics/master/docs/session.png)

### Tools — 工具取证

左侧工具表，右侧选中工具的调用时间桶、延迟直方图、agent / 项目分布、错误文案聚类与原文。

![Tools](https://raw.githubusercontent.com/kitsuneMori96/opencode-session-metrics/master/docs/tools.png)

### Compare — 两个会话并排

逐项差值表、按轮次序号对齐的输出曲线、工具构成对比。

![Compare](https://raw.githubusercontent.com/kitsuneMori96/opencode-session-metrics/master/docs/compare.png)

## 功能

### 全局切片（SliceBar）

顶端一条：`24h / 7d / 30d / 90d / 1y / all` 六个预设（默认 `24h`），加
`project / model / agent` 三个维度过滤。切片是**符号化**的：选预设时 URL 里只记
`range=7d`（永远是相对当前时间），只有手动框选图表才会写入绝对的 `from` / `to`。
切片的每一次变化都直接改 URL，所有面板（KPI、图、表、正文）一起重算。

时间轴的单位默认自动：三日以内按小时、半年以内按天、再长按周，
列数超过 200 就继续往粗里退，实际用的单位写在图的右上角（`gran=5m` 这类显式指定
仍然生效，但同样受这个上限约束——十年历史不会因为一句 `gran=5m` 就吐出几十万列）。

### 屏与路由

四个导航屏（`1`–`4`）加两个详情路由，共用同一套切片、表头与键盘。

- **Overview**（`/overview`）：KPI（Token / 成本 / 轮次 / 工具 / 错误 / 会话 / 输出 /
  增删行，各带与上一等长窗口的对比；没有更早的窗口时对比显示破折号而不是 +100%）、
  按模型堆叠的 Token 时间序列（可框选重新定窗口）、
  7×24 活跃热力图、24 小时分布、会话散点（x/y 可选 token / cost / turns / duration /
  output rate / context / errors / updated，对数轴可切）、项目 / 模型 / 工具 / agent 排行、
  效率面板（缓存命中、生成速度、轮次耗时 p50/p90/p99、上下文填充、未完成数）、
  最重会话列表（hover 时在散点里高亮同一个点；散点与列表都是最重的 200 个会话样本，
  其余在 Sessions 里翻页看）。
  - 图表手势：**在时间序列上拖拽 = 重新定义窗口**；**点任意排行条 = 按该维度过滤**；
    点散点 = 进该会话详情。
- **Sessions**（`/sessions`）：全部会话一张可排序、可展开的表（根会话下挂子代理会话，
  缩进显示层级）。列：标题 / 项目 / agent / 模型 / Token / 成本 / 轮次 / 工具调用 /
  错误 / 时长 / 上下文占用 / 更新时间。点一行进详情。过滤、排序与分页是服务端的：
  一次最多取 500 个根会话（连同各自的子树）。普通库一个请求就给全，所以看不到任何
  翻页控件；只有十年这种量级才会分页，滚到表尾自动续下一页，底部只写「已显示 X / 共 Y」。
  过滤命中子会话时会保留它的祖先，状态栏的合计始终描述整个命中集合，而不是已加载的部分。
- **Session 详情**（`/sessions/:id`）：Token 明细、形状（轮次、工具调用、墙钟、生成速度、
  上下文窗口与峰值）、工具用量、agent 链（父子/兄弟，可跳转）、逐轮 Token 时间线
  （框选 = 只留这几轮，点一轮 = 聚焦该轮）、正文面板（见下）、每轮花费。
- **Tools**（`/tools`、`/tools/:name`）：左侧工具表（调用数、失败数、p50 / p95 / max /
  均值耗时、涉及会话与 agent 数，列可排序），右侧选中工具的调用时间桶、延迟直方图、
  按 agent / 项目的分布、错误文案聚类（URL / 路径 / 数字归一后归并）、最近错误原文、写回的行数。
- **Compare**（`/compare?a=&b=`）：任选两个会话并排：逐项差值表（Token / 成本 /
  $ per Mtok / 轮次 / 工具 / 失败 / 墙钟 / 生成速度 / 峰值上下文 / 增删行，
  右侧为相对左侧的百分比变化）、按轮次序号对齐的输出 Token 曲线、工具构成对比。

### 正文面板（Session 详情）

用户 prompt（`>` 起头）与助手轮次交替展开：轮次头（模型、agent、输入/输出、耗时、
时刻、ctx 占用）、助手正文、推理块（折叠成一行预览）、每次工具调用一行
（`✓ / × / ◌` + 名称 + 标题 + 耗时），展开后看入参与回显（回显最多 40 行）。

默认过滤是 `text`——只留两侧的正文，不含思考与工具；连续几轮只有工具和思考、
没有正文时，折成一行 `▸ 14 turns · 20 tools · 15:14:54–15:16:21 · +336.2K tok`
（点一下或 `↵` 展开轮次头）。`tools` / `errors` 只留工具行，没有内容的轮次头
直接不显示。`all` 才是全部。工具栏给出 `rows 起–止/总`、过滤循环与命中数。

### 键盘

| 键 | 作用 |
| --- | --- |
| `1` `2` `3` `4` | Overview / Sessions / Tools / Compare |
| `/` 或 `⌘K` | 命令面板：跳转、切窗口、套用过滤、检索全库正文并跳会话 |
| `r` | 触发一次增量物化 |
| `esc` | 关闭面板 / 复位焦点 |
| `j` `k` `g` `G` | 正文面板里移动游标（虚拟滚动，只渲染可见行） |
| `n` `N` | 跳到下一个 / 上一个命中 |
| `f` | 过滤循环 `text → all → errors → tools`（默认 `text`：prompt + 正文） |
| `Enter` | 展开 / 折叠当前行的工具调用、推理块或折起的轮次 |
| `e` | 只看游标所在的那一轮（正文面板内的轮次过滤） |

底部状态栏给出当前屏可用的动作。

### 动效

一套语言，取自数字滚轮那条曲线：一条 `cubic-bezier(0.4,0,0.2,1)`、四档时长
（90 / 120 / 170 / 260ms）、六个动词——Roll（数字）、Press（指针态只变色）、
Ink（提示卡与面板落位）、Turn（字形转向）、Pulse（只给同步与首屏骨架）、
Wipe（图表按内容指纹重画）。

不弹、不放大、不滑整页；首屏、轮询、滚动追加都不播动画；框选、提示卡跟随、
坐标轴刻度这几处逐帧跟手的地方一律不做缓动。`prefers-reduced-motion` 下全部降到 1ms。
规则与实现见 [docs/motion.md](https://github.com/kitsuneMori96/opencode-session-metrics/blob/master/docs/motion.md)，`pnpm -F @osm/web test` 会跑一遍静态审计。

## 工作原理

```
opencode.db (只读)                    .data/metrics.db (查询用)
┌──────────────────────┐   增量物化    ┌──────────────────────────┐
│ session_v2           │ ────────────▶ │ turns · tools · parts     │
│ session_message      │  约 100ms/次  │ events · sessions         │
│ part · project       │               │ flow · heat · models      │
└──────────────────────┘               │ 日滚存 roll_cell / hour /  │
                                       │ tool（按天、按会话）       │
                                       └──────────┬───────────────┘
                                                  │ node:sqlite
                                      ┌───────────▼──────────┐
                                      │ Express API :8787    │
                                      └───────────┬──────────┘
                                      ┌───────────▼──────────┐
                                      │ Web 面板 (Vite/React) │
                                      └──────────────────────┘
```

指标不从源库实时计算：图表要的每个数字（时间桶、模型堆叠、热力图、百分位、
会话排行）都在服务端用 SQL 聚合好，一次请求返回当前切片的完整快照，
浏览器只负责画。物化由源库水位驱动（`MAX(消息时间, 会话更新时间)`），
只有源库出现新数据时才重建，且只重算受影响的会话。兼容源库 v1 与 v2 两代 schema。

查询不直接扫 `turns`。宽窗口（按天及更粗的分桶）读的是按天滚存的四张派生表：
（会话 × 天 × 项目/模型/agent）的合计、按小时的轮次、按天的工具调用与延迟直方图。
十年历史因此是几千行而不是几十万行；窗口两端被切开的半天仍从 `turns` 现算，
两半相加即精确。滚存不属于 `SCHEMA`，随物化在同一事务里更新，旧库在打开时按
`rollVersion` 就地补建——不需要重新读源库。百分位是唯一仍按轮扫描的部分：
细直方图的桶数在十年尺度上等同于轮数，预先聚合并不省任何东西。

`opencode-top` 每次刷新都重新解析源库的 JSON 正文；本项目的约定相反，正文在物化时就落进
`parts` 表，接口只读指标库。代价是库变大（正文占 108MB 里的绝大部分），换来的是
查询不碰源库、面板可以在会话之间随便点。

正文落库时有长度上限（text / reasoning 2000 字符、工具入参 1500、工具回显 3000），
超出部分面板本来就画不出来（回显最多展示 40 行）。

## 快速开始

从源码运行：要求 Node 24+、pnpm，且本机已存在 `opencode.db`。

```bash
pnpm install
pnpm build            # web/dist + server/dist
pnpm materialize --full
pnpm start            # http://127.0.0.1:8787
```

开发模式（server 热重载 + Vite 代理）：

```bash
pnpm dev              # API :8787 · Web :5174
```

首次启动若无指标库会自动物化；之后按水位增量更新。表结构变更后需要 `--full` 重建。

仓库里的 `bin/osm.js` 与 npm 包里的 `osm` 是同一个脚本，数据目录为仓库的 `.data`：

```bash
node bin/osm.js         # 起服务并开浏览器
node bin/osm.js stop
node bin/osm.js status
node bin/osm.js logs
```

`osm` 只起一个进程：Express 同时托管 API 与 `web/dist`，没有第二个端口，也不需要
另开 Vite。`OSM_HOST` / `OSM_PORT` 覆盖绑定地址和端口，`--no-open` 只起服务不开浏览器。
pid 与日志落在数据目录的 `osm.{pid,log}`。

## API

| 端点 | 说明 |
| --- | --- |
| `GET /api/status` | 物化状态、水位、各表行数 |
| `GET /api/top/facets` | 过滤器取值：项目 / 模型 / agent / 工具，加时间跨度与总行数 |
| `GET /api/top/analytics?from=&to=&project=&model=&agent=` | 当前切片的全部面板数据：totals、KPI 对比、时间桶与模型堆叠、热力图、效率百分位、四张排行表、最重的 200 个会话 |
| `GET /api/top/sessions?...&q=&order=&dir=&limit=&cursor=` | 会话表：`limit` 个根会话及其子树（默认且上限 500），`cursor` 续上一页；`focus=<id>` 换成该会话的族谱 |
| `GET /api/top/tool?name=` | 单个工具的调用桶、延迟直方图、agent/项目分布、参数签名、最近错误 |
| `GET /api/top/session/:id/messages` | 单会话的助手轮次与内容流，外加 `prompts`（用户提问，按时间与轮次交错）——唯一返回正文的端点 |
| `GET /api/top/search?q=` | 跨会话正文检索，返回命中会话与命中数 |
| `POST /api/refresh` | 手动重建，`{full:true}` 为全量 |

`from` / `to` 是 epoch 毫秒；`from=0` 表示从最早的数据开始。非数字或 `from >= to` 返回 400。
`analytics` 的响应与历史长度无关：时间轴按列预算取整，会话只带最重的 200 个
（全历史约 200KB）。会话表本身用 `cursor` 翻页，每页大小固定。

## 指标定义

- **Token 总量**（`total`）= input + output + cache_read + cache_write，**不含 reasoning**。
  推理 Token 单独给出。这套口径与 `opencode-top` 的 `TokenUsage.total` 相同。
- **切片口径**（与 `opencode-top` 有意不同）：统计「自己的 `created` 落在窗口内，
  且自己的 `project` / `model` / `agent` 命中过滤器」的助手轮次。原版的规则是
  「先选出窗口内活跃过的根会话，再补上它们的全部后代，最后只统计 cutoff 之后的轮次」——
  父会话静默时，挂在它下面的子会话会一并退出统计，而且按 model / agent 过滤在那种规则下
  没有意义。这里的规则是可加的、可交叉过滤的，代价是「一个跨窗口的长会话」在按天看时
  会出现在多个桶里。两套口径的差异见
  [docs/opencode-top-parity.md](https://github.com/kitsuneMori96/opencode-session-metrics/blob/master/docs/opencode-top-parity.md)。
- **上下文占用**（`context`）= input + cache_read + cache_write，对整会话求和后除以模型窗口。
  这是一个「上下文流量」指标而不是瞬时占用：长会话会数倍于一个窗口（面板在这种情况下
  显示 `×N`）。`fill` 是另一回事：发送时的 prompt_total / context_window，用于定位压缩触发点。
- **生成速度**（`output_rate`）= 该会话每个助手轮次 `output / ((completed - created)/1000)` 的
  **中位数**，在物化时算好；耗时缺失（中途休眠导致 `completed` 写到数小时后）的轮次会拉低
  这个值，因此取中位数而不是均值。
- **重试**（`retry`）：同一签名的工具调用在上一次失败后 15 分钟内再次出现。
  连续 ≥3 次同签名调用记为 `loop`。此前仅按签名去重，产生了大量误报（1345 → 28 条）。
- **代码改动行数**：解析工具调用产生的 unified diff，只统计 hunk 内部的 `+` / `-` 行
  （`Index:` / `---` / `+++` 等头部不计入）。整文件 `write` 按写入行数单独记为 `write_lines`：
  它是一次覆盖而不是增量，两者量纲不同，任何时候都不相加。

## 数据表

| 表 | 粒度 | 主要字段 |
| --- | --- | --- |
| `turns` | 每条消息（`role` = assistant / user） | 各类 Token、成本、`fill` / `fill_after`、改动增量与 `write_lines`、预计算的 `bucket` / `day` / `hour`；user 行只带 `text`（正文面板的提问行） |
| `tools` | 每次工具调用 | 状态、耗时、错误文本、改动与写入行数、调用签名、`target_session`（task 子会话） |
| `parts` | 每条助手内容 | `kind`（text / reasoning / tool）、`ordinal`、正文或工具入参/回显、`exit_code`、是否截断 |
| `events` | 每个事件 | 类型、`at` / `end_at`、`count`、`fill`、JSON 详情 |
| `sessions` | 每会话 | 聚合统计：Token、成本、填充率、`output_rate`、压缩/重试/循环次数、父子关系 |
| `flow` | 项目 × 5 分钟 | `tokens_gen`、`tokens_cache_read`、成本、主导模型 |
| `heat` | 项目 × 本地日 × 小时 | Token、成本、轮次数 |
| `models` | 每模型 | 价目、上下文窗口（models.dev 缓存 + 手工覆盖） |
| `meta` | — | 水位、物化时间、源库路径 |

## 开发

```bash
pnpm dev                    # server + web
pnpm typecheck              # 两个包 tsc --noEmit
pnpm test                   # ETL 测试（离线 fixture，36 项断言，无需服务与网络）
pnpm -F @osm/server test:smoke   # HTTP 冒烟测试（需服务在线，9 项）
pnpm materialize            # 增量物化
pnpm materialize --full     # 全量重建（写入临时文件后原子替换）
```

前端图表用 `@visx/*`（d3 的无样式原语）与 `@tanstack/react-table` +
`@tanstack/react-virtual` 自己拼装，没有引入组件库；配色、hairline、等宽微字都在这套
仓库自己的样式里（`web/src/index.css`）。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OSM_SOURCE_DB` | `~/.local/share/opencode/opencode.db` | 源库路径（只读） |
| `OSM_DATA_DIR` | `<项目根>/.data` | 指标库与价目缓存目录（已 gitignore） |
| `OSM_HOST` | `127.0.0.1` | API 监听地址 |
| `OSM_PORT` | `8787` | API 端口 |
| `OSM_OFFLINE` | — | 设为 `1` 时不访问 models.dev，价目走缓存或零值兜底 |

## 实测性能

测试数据集：562MB 源库 · 222 会话 · 25,352 轮 · 25,686 次工具调用 · 52,264 条正文。

| 项目 | 数值 |
| --- | --- |
| 全量物化 | 5.7s（含正文落库） |
| 增量物化 | 约 100ms |
| 指标库体积 | 108MB |
| `analytics` 全历史 | 82ms / 200KB（按天分桶，176 列） |
| `analytics` 7 天 | 23ms / 18KB |
| `analytics` 3 天（按小时分桶） | 19ms / 26KB |
| `facets` | 38ms / 5.5KB |
| `tool` 明细 | 71ms / 16KB |
| 会话正文 | 0.1–2.4MB，按需加载 |
| 会话表（224 个会话一次给全） | 20ms / 169KB |

另用合成十年库（46.6 万轮、40 万次工具调用、618MB）压过同一套查询：全历史
1.5s（加滚存前 11.8s），响应 177KB；会话分页 93ms（此前 1.4s）。该库由脚本生成，
不含真实内容，只用来验证「响应体积与历史长度无关」。

## 目录结构

```
bin/osm.js                # npm 入口：起服务、开浏览器、stop/status/logs
server/src/
├── index.ts              # 启动、静态托管、水位驱动的刷新循环
├── api.ts                # REST 端点
├── source.ts             # 源库 v1/v2 解析（含正文抽取）
├── config.ts             # 路径、端口、时间桶宽度
└── metrics/
    ├── schema.ts         # 指标库表结构
    ├── build.ts          # 物化逻辑（轮次指标、正文、事件探针、聚合）
    ├── store.ts          # 增量编排、原子替换
    ├── analytics.ts      # 切片聚合：dashboard / toolDetail / facets
    └── catalog.ts        # 模型价目（缓存 + 手工覆盖）
web/src/
├── screens/              # Overview / Sessions / SessionDetail / Tools / Compare
├── components/
│   ├── Chrome.tsx        # 顶栏、切片条、状态栏
│   ├── DataTable.tsx     # 虚拟化表格（排序、树形展开）
│   ├── Transcript.tsx    # 虚拟化正文面板
│   ├── Palette.tsx       # ⌘K 命令面板
│   └── charts/           # 时间序列、排行条、热力图、散点
└── lib/                  # API 客户端、切片状态、格式化、图表工具、正文行模型
```

## 相关文档

- [docs/opencode-top-parity.md](https://github.com/kitsuneMori96/opencode-session-metrics/blob/master/docs/opencode-top-parity.md) — 与 `opencode-top` 的功能对照，
  以及两处有意的口径差异
- [docs/backend-refactor.md](https://github.com/kitsuneMori96/opencode-session-metrics/blob/master/docs/backend-refactor.md) — 2026-10 后端重构的接口变更明细
- [docs/motion.md](https://github.com/kitsuneMori96/opencode-session-metrics/blob/master/docs/motion.md) — 动效令牌、六个动词、交互对照与静态审计的规则
