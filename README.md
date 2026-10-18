# Holo-Cockpit · OpenCode 会话监控与分析全息复盘舱

把 OpenCode 本机的会话数据库（`~/.local/share/opencode/opencode.db`）**物化**成一张可秒查的指标库，
再用一套瑞士排版 × 精密医疗仪器风格的 Web 座舱，把你的编码活动当作一条病人生命体征来复盘。

四个系统，一块三联屏：

| # | 系统 | 你能回答的问题 |
| --- | --- | --- |
| ① | **项目心电图 + 时间切片器** | 哪个项目在什么时候真正烧了多少 Token？拖动时间轴，整舱联动重切 |
| ② | **会话解剖** | 这段会话的上下文是怎么涨到要压缩的？哪次工具调用失败了？子代理从哪分叉出去的？ |
| ③ | **生物钟热力图 + 注意力集中度** | 我几点最能产出？连续工作段多长？被打断的频率如何？ |
| ④ | **Token→Diff 转化率 + 预算沙盘** | 哪些会话是「注水会话」（Token 花了、代码没写）？换个模型/提高缓存命中能省多少？ |

---

## 架构

```
 opencode.db (535MB, 只读)                .data/metrics.db (查询用)
┌─────────────────────────┐    水位驱动    ┌──────────────────────────┐
│ session_v2 / session_    │ ──增量物化──▶ │ turns · tools · events    │
│ message / part / project │   ~109ms/次   │ sessions · flow · heat    │
└─────────────────────────┘                │ models · meta             │
        v1/v2 双 schema 兼容               └────────────┬─────────────┘
                                                        │ node:sqlite
                                          ┌─────────────▼─────────────┐
                                          │ Express 5 API :8787        │
                                          │ 10 个 GET + 沙盘/覆盖/刷新  │
                                          └─────────────┬─────────────┘
                                                        │
                                          ┌─────────────▼─────────────┐
                                          │ React 19 座舱 (Vite 6)      │
                                          │ 三联屏 · 时间切片器 · 扫描线 │
                                          └───────────────────────────┘
```

**核心决策：不在请求时解析 535MB 的 SQLite JSON。** 源库只读、只在物化时打开；
前端所有查询都打在按需重建的指标库上，全量 2.7s、增量 109ms。

---

## 快速开始

前置：Node 24+（用 `node:sqlite`，零原生依赖）、pnpm、本机已存在 `opencode.db`。

```bash
pnpm install

# 生产模式：物化指标库 → 起 API → 自动服务 web/dist
pnpm build          # 构建座舱到 web/dist
pnpm materialize --full
pnpm start          # http://127.0.0.1:8787

# 开发模式：server 热重载 + vite 开发服（/api 代理到 8787）
pnpm dev            # API :8787 · Web :5174
```

没跑过 `pnpm build` 也没关系 —— 服务启动时会自动物化，并且只在源库真的有新数据时才重建。

---

## API 速查

窗口参数统一为 `from`/`to`（epoch ms，缺省最近 30 天）；非法值返回 `400` 而不是静默零值。

| 端点 | 用途 |
| --- | --- |
| `GET /api/status` | 物化状态、水位、各表行数 |
| `GET /api/overview` | 窗口总览：token 四桶分列、按模型、diff 覆盖率 |
| `GET /api/ecg` | 心电图：每项目一条泳道，token 流按桶聚合（过宽窗口自动合并，≤900 点/泳道） |
| `GET /api/sessions` | 窗口内会话列表（效率、压缩/重试/循环计数、diff 行数） |
| `GET /api/session/:id` | 会话解剖：整棵子代理子树、`task` 分叉点、轮次、事件、探针读数（`?include=text` 才带正文） |
| `GET /api/events` | 事件标记层：失败 X 十字 / 压缩琥珀箭头 / 重试横线（含 `end_at`、`count`） |
| `GET /api/heatmap` | 生物钟：7×24 矩阵 + 逐日逐小时声谱 + 现成结论句 |
| `GET /api/focus` | 注意力：工具调用间隔 p50/p90/p99、深度工作占比、直方图 |
| `GET /api/conversion` | Token→Diff 散点 + 对数回归 + 注水会话标记 + 覆盖率 |
| `GET /api/models` | 模型价目与用量 |
| `POST /api/sandbox` | 预算沙盘：`{swaps:[{from,to}], cacheReadGain}` → 新旧成本对比 |
| `PUT /api/models/:key` | 手工价格覆盖（免费档模型 models.dev 标价为 0） |
| `POST /api/refresh` | 手动重建，`{full:true}` 强制全量 |

---

## 指标库 schema

| 表 | 粒度 | 说明 |
| --- | --- | --- |
| `turns` | 每轮 LLM 调用 | token 四桶、成本、`fill`（发送时上下文占用）/`fill_after`、预计算 `bucket`/`day`/`hour` |
| `tools` | 每次工具调用 | 状态、耗时、diff 行数、签名、`input_preview`、`target_session`（task 子会话） |
| `events` | 每个事件 | `compaction` / `retry` / `loop` / `failure` / `idle` / `switch`，带 `end_at`、`count`、`fill` |
| `sessions` | 每会话 | 聚合读数：效率分、峰值/均值填充率、压缩/重试/循环数、diff 行数、父会话与深度 |
| `flow` | 项目 × 5 分钟桶 | 心电图基底：`tokens_gen` 与 `tokens_cache_read` **分列**，附主导模型 |
| `heat` | 项目 × 本地日 × 小时 | 生物钟声谱基底，任意时间窗可重切 |
| `models` | 每模型 | 价目与上下文窗口（models.dev 缓存 + 手工覆盖） |
| `meta` | — | 水位、物化时间、源库指纹 |

---

## 口径约定（改代码前必读）

1. **`tokens_gen` 与 `cache_read` 永远分列。** 本库缓存读约是生成量的 14 倍，
   混进波形会把一切压平。生成量 = input + output + reasoning。
2. **`fill` = 发送时上下文占用**（prompt_total / context_window），压缩点读数因此对齐真实触发条件；
   `fill_after` 才是「加上本轮输出后」的占用。
3. **重试语义收紧**：只有「前次失败或本次失败 + ≤15 分钟邻接」才算 `retry`；
   ≥3 次同签名连续重复算 `loop`（时间黑洞横线）。此前按签名去重导致 1345 条虚报，现为 28 条。
4. **刷新由源库水位驱动**：`MAX(消息表, session_v2.time_updated)` 没前进就直接跳过；
   有变化只重算脏会话，并只重聚合受影响的 flow 桶与 heat 日。
5. **默认绑 `127.0.0.1`** —— 载荷里有你的明文 prompt，安全性靠回环绑定（CORS 本身全开）。
   局域网访问需显式 `HOLO_HOST=0.0.0.0`。

---

## 开发命令

```bash
pnpm dev                     # server + web 双热重载
pnpm typecheck               # 两个包一起 tsc --noEmit
pnpm test                    # 离线 ETL 测试（25 项断言，无需服务与网络）
pnpm -F @holo/server test:smoke   # HTTP 冒烟（需服务在线）
pnpm materialize             # 增量物化
pnpm materialize --full      # 全量重建（写 .next 后原子换名，读侧无感）
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOLO_SOURCE_DB` | `~/.local/share/opencode/opencode.db` | 源库路径（只读） |
| `HOLO_DATA_DIR` | `<root>/.data` | 指标库与价目缓存目录（已 gitignore） |
| `HOLO_HOST` | `127.0.0.1` | API 监听地址 |
| `HOLO_PORT` | `8787` | API 端口 |
| `HOLO_OFFLINE` | — | 设为 `1` 时价目不访问 models.dev，走缓存/兜底 |

---

## 性能基线

实测数据集：535MB 源库 · 221 会话 · 24,159 轮 · 24,423 次工具调用 · 72 天跨度。

| 指标 | 数值 |
| --- | --- |
| 全量物化 | 2.7s |
| 增量物化（只重算脏会话） | 109ms |
| 30 天窗口端点耗时 | overview 15ms · ecg 3.5ms · sessions 3ms · heatmap 9ms · conversion 2ms |
| 会话详情载荷 | 默认不含正文，几十 KB（`?include=text` 才展开） |

---

## 目录结构

```
server/src/
├── index.ts              # 启动、静态托管 web/dist、水位驱动的刷新循环
├── api.ts                # 全部 REST 端点
├── source.ts             # 源库 v1/v2 解析（会话/轮次/工具/事件/patch 文件数）
├── config.ts             # 路径、端口、桶宽、监听地址
└── metrics/
    ├── schema.ts         # 指标库建表与 meta
    ├── build.ts          # 物化：轮次指标、重试/循环探针、压缩前后、flow/heat 聚合
    ├── store.ts          # 增量编排、.next 原子换名、句柄 inode 校验
    └── catalog.ts        # models.dev 价目（7 天 TTL）与手工覆盖
web/src/
├── components/           # 三联屏各面板（心电图、热力图、解剖、托盘沙盘）
├── state/                # 时间窗/选中会话/项目过滤的联动上下文
└── lib/                  # API 客户端、格式化、调色板
```

---

## 设计语言

医用钛白底 `oklch(0.96 0.01 240)` · 1px 深墨蓝锐利波形 · 工程网格纸 · 直角无圆角 ·
JetBrains Mono 超大仪表数字 · 鼠标扫描线悬停 · 琥珀压缩闪烁 · 红色战术 X 标记。
颜色是有配额的：常态只有墨蓝一种色相，红/琥珀/钴蓝只用于信号。

API 重构细节与破坏性变更见 [`docs/backend-refactor.md`](docs/backend-refactor.md)。
