# OpenCode Session Metrics

将 OpenCode 的本机数据库（`~/.local/share/opencode/opencode.db`）物化为一张指标库，
再用一个 Web 面板回看自己的编码会话：跑了哪些会话、花了多少 Token、调用了哪些工具、
每个工具失败过几次、钱花在哪个项目上。

界面按 [`opencode-top`](docs/opencode-top-parity.md) 的三个屏一比一对齐
（Sessions / Tools / Overview），数据口径也照抄它的实现；视觉换成这套项目的
医用纸白 + 墨蓝 hairline 风格。

数据只在本机流转，API 默认绑定 `127.0.0.1`。

## 功能

三个屏，左上角 tab 或按键 `1` / `2` / `3` 切换。

- **Sessions**（`/api/top/sessions`）：左侧是会话树，根会话下挂着它的子代理会话，
  显示标题、更新时间、Token、成本；右侧 `Tab` 在 **Stats** 与 **Messages** 之间切换。
  - Stats：Token / 成本 / 时长 / 生成速度 / 轮次数、上下文占用条、按模型与按工具的用量、
    AGENT CHAIN（子代理链，超过 5 个默认折叠，`c` 展开）
  - Messages：该会话的助手轮次正文，逐条列出模型、输入输出 Token、耗时，
    工具调用可展开看入参与回显（含退出码与截断标记），推理块折叠成一行预览
  - `/` 搜索：左栏按标题/项目/首条提问过滤，同时对全库正文做检索并按命中数列出会话；
    `n` / `N` 在命中之间跳，`f` 循环 all → errors → tools → text 过滤，`Enter` 展开/折叠
- **Tools**（`/api/top/tools`）：每个工具的调用数、失败率、平均耗时，
  以及它最近产生的 3 条错误；排序键 `calls` / `failures` / `avg-time`，`Tab` 切换
- **Overview**（`/api/top/overview`）：时间范围（今天 / 7 天 / 30 天 / 90 天 / 全部）与项目过滤下的
  汇总 Token 与花费、Token 趋势与会话趋势柱图、24 小时活跃分布、按 agent 的工具错误率、
  工具调用排行、项目排行、最慢工具、模型排行；`t` 循环时间范围，`p` / `P` 循环项目

底部状态栏给出当前屏的可用按键，右上角 `r` 触发一次增量物化。

## 工作原理

```
opencode.db (只读)                    .data/metrics.db (查询用)
┌──────────────────────┐   增量物化    ┌──────────────────────────┐
│ session_v2           │ ────────────▶ │ turns · tools · parts     │
│ session_message      │  约 100ms/次  │ events · sessions         │
│ part · project       │               │ flow · heat · models      │
└──────────────────────┘               └──────────┬───────────────┘
                                                  │ node:sqlite
                                      ┌───────────▼──────────┐
                                      │ Express API :8787    │
                                      └───────────┬──────────┘
                                      ┌───────────▼──────────┐
                                      │ Web 面板 (Vite/React) │
                                      └──────────────────────┘
```

指标不从源库实时计算：请求打在物化好的指标库上。物化由源库水位驱动
（`MAX(消息时间, 会话更新时间)`），只有源库出现新数据时才重建，且只重算受影响的会话。
兼容源库 v1 与 v2 两代 schema。

`opencode-top` 每次刷新都重新解析源库的 JSON 正文；本项目的约定相反，正文在物化时就落进
`parts` 表，接口只读指标库。代价是库变大（正文占 105MB 里的绝大部分），换来的是
查询不碰源库、面板可以在会话之间随便点。

正文落库时有长度上限（text / reasoning 2000 字符、工具入参 1500、工具回显 3000），
超出部分面板本来就画不出来（回显最多展示 40 行）。

## 快速开始

要求 Node 24+（使用内置 `node:sqlite`，无原生依赖）、pnpm，且本机已存在 `opencode.db`。

```bash
pnpm install
pnpm build            # 构建 Web 面板到 web/dist
pnpm materialize --full
pnpm start            # http://127.0.0.1:8787
```

开发模式（server 热重载 + Vite 代理）：

```bash
pnpm dev              # API :8787 · Web :5174
```

首次启动若无指标库会自动物化；之后按水位增量更新。表结构变更后需要 `--full` 重建。

## API

| 端点 | 说明 |
| --- | --- |
| `GET /api/status` | 物化状态、水位、各表行数 |
| `GET /api/top/sessions` | 全部会话 + 每会话的模型/工具明细（左树与 Stats 面板的数据源） |
| `GET /api/top/session/:id/messages` | 单会话的助手轮次与内容流（唯一返回正文的端点） |
| `GET /api/top/tools` | 全局工具聚合：调用数、成功/失败、平均耗时、最近错误 |
| `GET /api/top/overview?from=&project=` | 区间/项目聚合：汇总 Token、趋势桶、24 小时分布、各类排行 |
| `GET /api/top/search?q=` | 跨会话正文检索，返回命中会话与命中数 |
| `POST /api/refresh` | 手动重建，`{full:true}` 为全量 |

`from` 是 cutoff（epoch 毫秒，0 或缺省表示全部）。Overview 的区间口径与 `opencode-top` 一致：
先按项目与 cutoff 选出根会话，再补上它们的全部后代会话，最后只统计 cutoff 之后的轮次——
父会话静默时，挂在它下面的子会话也一并退出统计。

## 指标定义

- **Token 总量**（`tokens.total`）= input + output + cache_read + cache_write，**不含 reasoning**。
  推理 Token 单独给出。这套口径与 `opencode-top` 的 `TokenUsage.total` 相同。
- **上下文占用**（`context`）= input + cache_read + cache_write，对整会话求和后除以模型窗口。
  这是一个「上下文流量」指标而不是瞬时占用：长会话会数倍于一个窗口（面板在这种情况下
  显示 `×N`）。原版就是这么算的，这里照抄。
- **生成速度**（`output_rate`）= 该会话每个助手轮次 `output / ((completed - created)/1000)` 的
  **中位数**，在物化时算好；耗时缺失（中途休眠导致 `completed` 写到数小时后）的轮次会拉低
  这个值，因此取中位数而不是均值。
- **重试**（`retry`）：同一签名的工具调用在上一次失败后 15 分钟内再次出现。
  连续 ≥3 次同签名调用记为 `loop`。此前仅按签名去重，产生了大量误报（1345 → 28 条）。
- **代码改动行数**：解析工具调用产生的 unified diff，只统计 hunk 内部的 `+` / `-` 行
  （`Index:` / `---` / `+++` 等头部不计入）。整文件 `write` 按写入行数单独记为 `write_lines`：
  它是一次覆盖而不是增量，两者量纲不同，任何时候都不相加。
- **`fill`**：发送时的上下文占用（prompt_total / context_window），用于定位上下文压缩的触发点。

## 数据表

| 表 | 粒度 | 主要字段 |
| --- | --- | --- |
| `turns` | 每轮 LLM 调用 | 各类 Token、成本、`fill` / `fill_after`、改动增量与 `write_lines`、预计算的 `bucket` / `day` / `hour` |
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
pnpm -F @osm/server test:smoke   # HTTP 冒烟测试（需服务在线，10 项）
pnpm materialize            # 增量物化
pnpm materialize --full     # 全量重建（写入临时文件后原子替换）
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OSM_SOURCE_DB` | `~/.local/share/opencode/opencode.db` | 源库路径（只读） |
| `OSM_DATA_DIR` | `<项目根>/.data` | 指标库与价目缓存目录（已 gitignore） |
| `OSM_HOST` | `127.0.0.1` | API 监听地址 |
| `OSM_PORT` | `8787` | API 端口 |
| `OSM_OFFLINE` | — | 设为 `1` 时不访问 models.dev，价目走缓存或零值兜底 |

## 实测性能

测试数据集：548MB 源库 · 221 会话 · 24,725 轮 · 25,018 次工具调用 · 51,107 条正文。

| 项目 | 数值 |
| --- | --- |
| 全量物化 | 5.7s（含正文落库） |
| 增量物化 | 约 100ms |
| 指标库体积 | 105MB（旧版不含正文时 28MB） |
| 端点耗时 | sessions 70ms · overview 190ms（全量区间）· messages 34ms |
| 会话正文载荷 | 单会话 0.1–2.4MB，按需加载 |

## 目录结构

```
server/src/
├── index.ts              # 启动、静态托管、水位驱动的刷新循环
├── api.ts                # REST 端点
├── source.ts             # 源库 v1/v2 解析（含正文抽取）
├── config.ts             # 路径、端口、时间桶宽度
└── metrics/
    ├── schema.ts         # 指标库表结构
    ├── build.ts          # 物化逻辑（轮次指标、正文、事件探针、聚合）
    ├── store.ts          # 增量编排、原子替换
    ├── trend.ts          # 趋势分桶（小时 / 天 / 周自适应）
    └── catalog.ts        # 模型价目（缓存 + 手工覆盖）
web/src/
├── screens/              # Sessions / Tools / Overview 三个屏
├── components/           # 会话树、Stats、Messages、柱图等
└── lib/                  # API 客户端、格式化、工作流分组
```

## 相关文档

- [docs/opencode-top-parity.md](docs/opencode-top-parity.md) — 与 `opencode-top` 的屏/字段对照表
- [docs/backend-refactor.md](docs/backend-refactor.md) — 2026-10 后端重构的接口变更明细
