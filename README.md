# OpenCode Session Metrics

将 OpenCode 的本机数据库（`~/.local/share/opencode/opencode.db`）物化为一张指标库，
提供 REST API 与一个 Web 面板，用于回看自己的编码会话：Token 消耗、上下文占用、
工具调用、上下文压缩、产出效率。

数据只在本机流转，API 默认绑定 `127.0.0.1`。

## 功能

- **时间序列视图**（`/api/ecg`、`/api/ecg/ops`）：按项目分泳道的 Token 流量曲线；窗口收窄到半天以内时切换为操作级波形，每个工具调用/轮次是一个尖峰
- **宽窗口分层视图**（`/api/ecg/daily`）：按项目分泳道，每条泳道分「产出 / 消耗 / 效率」三层带并共享时间轴，
  用于看出「消耗冲高、产出没动」这类背离；泳道表头直接给出统计与结论
- **会话明细**（`/api/session/:id`）：单个会话的轮次、工具调用、事件（压缩 / 失败 / 重试）与子代理树
- **时间分布**（`/api/heatmap`、`/api/focus`）：按星期×小时的活动分布，以及工具调用间隔统计
- **产出效率**（`/api/conversion`）：Token 消耗与代码改动行数的关系，用于识别低产出会话
- **成本测算**（`/api/sandbox`）：按不同模型价格、缓存命中率估算同一时间段的成本

## 工作原理

```
opencode.db (只读)                    .data/metrics.db (查询用)
┌──────────────────────┐   增量物化    ┌─────────────────────┐
│ session_v2           │ ────────────▶ │ turns · tools        │
│ session_message      │  约 100ms/次  │ events · sessions    │
│ part · project       │               │ flow · heat · models │
└──────────────────────┘               └──────────┬──────────┘
                                                  │ node:sqlite
                                      ┌───────────▼──────────┐
                                      │ Express API :8787     │
                                      └───────────┬──────────┘
                                      ┌───────────▼──────────┐
                                      │ Web 面板 (Vite/React) │
                                      └──────────────────────┘
```

指标不从源库实时计算：请求打在物化好的指标库上。物化由源库水位驱动
（`MAX(消息时间, 会话更新时间)`），只有源库出现新数据时才重建，且只重算受影响的会话。
兼容源库 v1 与 v2 两代 schema。

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

首次启动若无指标库会自动物化；之后按水位增量更新。

## API

窗口参数统一为 `from` / `to`（epoch 毫秒，默认最近 30 天）。参数非法返回 400。

| 端点 | 说明 |
| --- | --- |
| `GET /api/status` | 物化状态、水位、各表行数 |
| `GET /api/overview` | 窗口汇总：各类 Token 计数、按模型分组、代码改动数据覆盖率 |
| `GET /api/ecg` | 按项目分泳道的 Token 时间序列（窗口过宽时自动合并时间桶，每泳道 ≤900 点） |
| `GET /api/ecg/ops` | 操作级波形：每个工具调用（基线之上）与每轮助手输出（基线之下），`d` 为耗时即尖峰宽度 |
| `GET /api/ecg/daily` | 项目 × 时间桶的分层汇总；`bucket=day`（默认）或 `hour` |
| `GET /api/sessions` | 窗口内会话列表及各项统计 |
| `GET /api/session/:id` | 会话明细：子代理树、轮次、工具调用、事件（正文需 `?include=text`） |
| `GET /api/events` | 事件列表（压缩 / 失败 / 重试 / 循环 / 空闲 / 模型切换） |
| `GET /api/heatmap` | 按星期×小时的分布矩阵，以及逐日逐小时明细 |
| `GET /api/focus` | 工具调用时间间隔的分位数与直方图 |
| `GET /api/conversion` | Token 与代码改动行数的散点、对数回归、覆盖率 |
| `GET /api/models` | 模型价目与用量 |
| `POST /api/sandbox` | 成本测算：`{swaps:[{from,to}], cacheReadGain}` |
| `PUT /api/models/:key` | 手工修正模型价格（免费档模型在 models.dev 上标价为 0） |
| `POST /api/refresh` | 手动重建，`{full:true}` 为全量 |

字段级变更说明见 [docs/backend-refactor.md](docs/backend-refactor.md)。

## 指标定义

- **生成量** = input + output + reasoning；**缓存读**（cache_read）单独统计。
  本数据集中缓存读约为生成量的 14 倍，两者合并会使图表失去分辨力。
- **`fill`** = 发送时的上下文占用（prompt_total / context_window），
  反映上下文压缩的实际触发条件；`fill_after` 为计入本轮输出后的占用。
- **重试**（`retry`）：同一签名的工具调用在上一次失败后 15 分钟内再次出现。
  连续 ≥3 次同签名调用记为 `loop`。此前仅按签名去重，产生了大量误报（1345 → 28 条）。
- **代码改动行数**：解析工具调用产生的 unified diff，只统计 hunk 内部的 `+` / `-` 行
  （`Index:` / `---` / `+++` 等头部不计入）。整文件 `write` 按写入行数单独记为 `write_lines`：
  它是一次覆盖而不是增量，两者量纲不同，任何时候都不相加。
  早期实现只读 v1 `part` 表的 patch，v2 会话的改动因此全部漏算（2,928 → 20,639 行）。
  无改动数据的会话计入 `coverage` 分母，不参与回归拟合。

## 数据表

| 表 | 粒度 | 主要字段 |
| --- | --- | --- |
| `turns` | 每轮 LLM 调用 | 各类 Token、成本、`fill` / `fill_after`、改动增量与 `write_lines`、预计算的 `bucket` / `day` / `hour` |
| `tools` | 每次工具调用 | 状态、耗时、改动与写入行数、调用签名、`target_session`（task 子会话） |
| `events` | 每个事件 | 类型、`at` / `end_at`、`count`、`fill`、JSON 详情 |
| `sessions` | 每会话 | 聚合统计：效率分、填充率、压缩/重试/循环次数、改动行数、父子关系 |
| `flow` | 项目 × 5 分钟 | `tokens_gen`、`tokens_cache_read`、成本、主导模型 |
| `heat` | 项目 × 本地日 × 小时 | Token、成本、轮次数 |
| `models` | 每模型 | 价目、上下文窗口（models.dev 缓存 + 手工覆盖） |
| `meta` | — | 水位、物化时间、源库路径 |

## 开发

```bash
pnpm dev                    # server + web
pnpm typecheck              # 两个包 tsc --noEmit
pnpm test                   # ETL 测试（离线 fixture，29 项断言，无需服务与网络）
pnpm -F @osm/server test:smoke   # HTTP 冒烟测试（需服务在线）
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

测试数据集：535MB 源库 · 221 会话 · 24,159 轮 · 72 天跨度。

| 项目 | 数值 |
| --- | --- |
| 全量物化 | 2.7s |
| 增量物化 | 109ms |
| 30 天窗口端点耗时 | overview 15ms · ecg 3.5ms · sessions 3ms · heatmap 9ms · conversion 2ms |
| 会话明细载荷 | 默认不含正文，数十 KB |

## 目录结构

```
server/src/
├── index.ts              # 启动、静态托管、水位驱动的刷新循环
├── api.ts                # REST 端点
├── source.ts             # 源库 v1/v2 解析
├── config.ts             # 路径、端口、时间桶宽度
└── metrics/
    ├── schema.ts         # 指标库表结构
    ├── build.ts          # 物化逻辑（轮次指标、事件探针、聚合）
    ├── store.ts          # 增量编排、原子替换
    └── catalog.ts        # 模型价目（缓存 + 手工覆盖）
web/src/
├── components/           # 面板组件
├── state/                # 时间窗与选中状态
└── lib/                  # API 客户端、格式化、配色
```

## 相关文档

- [docs/backend-refactor.md](docs/backend-refactor.md) — 2026-10 后端重构的接口变更明细
