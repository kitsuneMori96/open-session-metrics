# 后端重构交接说明（给 Qoder）

日期：2026-10-18 · 提交：`f955fb3`（基于 `2d7c540`）
范围：**只动了 `server/`**，`web/` 一行未改，构建产物 `web/dist` 也不受影响。

> 后续变更：本文件之后，界面改为对位 `opencode-top` 的三屏结构，接口随之重排为
> `/api/top/*`（见 `docs/opencode-top-parity.md`）；再之后前端重排为单页仪表盘，
> 端点收敛为切片型的 `/api/top/{facets,analytics,tool}`（见第 7 节）。
> 下面的端点清单只描述当时的状态。

后端这次按 P0 优先级把物化管线和 API 口径整个过了一遍。对你影响最大的是：
**几个端点的响应结构变了，而且非法参数不再静默返回零值**。下面是完整清单。

---

## 1. 破坏性变更（前端必须适配）

### 1.1 参数校验变成 400

`from`/`to` 非数字或 `from >= to` 时，所有带窗口的端点返回：

```
400 {"error": "from/to must be epoch milliseconds"}
400 {"error": "`from` must be earlier than `to`"}
```

以前是 200 + `step:null` / 全零数据。`fetch` 后记得先看 `res.ok`。

### 1.2 `/api/session/:id` —— 结构大改 + 文本按需加载

```
{ session, subtree, forks, turns, tools, events, prompts, children, probe }
```

- **`turns` 默认不含 `text` 字段**（载荷从 621KB 降到几十 KB），要看正文传 `?include=text`。
- `subtree` 是整棵子代理树的 id 列表：递归 `parent_id` + `task` 工具指向的子会话（后者见 `forks`）。
- `forks`：`[{turn_id, started, target_session, title, status}]` —— 消息树的分叉点。
- `probe`：`{failuresOver80, compactions, retries, loops, peakFill, avgFill, effScore, tokensPerLine, diffLines, tokens}`，
  对应上下文健康度带状图和解剖面板的探针读数。
- `children` 只含直接子会话摘要。

### 1.3 `/api/heatmap` —— 从固定 7×24 变成「7×24 + 逐日声谱」

```
{ days, fromDay,
  cells:       [{ dow, hour, gen, cache, cost, turns }],   // dow 周一=0，窗口内聚合
  spectrogram: [{ day, hour, gen, cache, cost, turns }],   // 逐日逐小时，day=本地零点时间戳
  totalTokens, totalCacheRead, nightShare, peak, topHour, insight }
```

底层 heat 表按**本地日**重设计（`project, day, hour`），所以时间切片器拖到任意区间都能重切，
不再是只有固定 7 天窗口的版本。`insight` 是现成的中文结论句，可直接显示。

### 1.4 token 口径统一（`/api/overview`、`/api/ecg`）

以前三处口径不一致（flow 排 cache、heatmap 含 cache、overview 混用）。现在**永远分列**：

- `tokens_gen` / `generated` = input + output + reasoning（波形、效率计算用这个）
- `tokens_cache_read` / `cache_read` = 缓存读（本库约 14 倍于生成量，绝不能相加进波形）
- `/api/ecg` 的点：`{project, bucket, tokens, cache, cost, sessions, peak, model}`，
  `tokens` 即生成量，`cache` 即缓存读。窗口过宽时服务端会合并桶，`step` 字段会变粗（上限 900 点/泳道）。
- `/api/overview` 的 `totals` 同时给出 `generated`（来自 flow）与逐项 `input/output/reasoning/cache_read/cache_write`，
  另有 `coverage:{total, with_diff, with_cost}` 说明数据可信度。

### 1.5 `/api/conversion` —— `regression` 可能为 `null`

```
{ points: [{...session, expected_lines, ratio}],
  regression: { slope, intercept } | null,   // withDiff < 3 时为 null，必须判空
  linesPer10k, padded: [...], coverage: { total, withDiff } }
```

`points` 不再被 `cost > 0` 过滤掉（以前 30 天窗口只剩 2 个点），现在是 45 个。
没有 diff 数据的会话留在 `points` 里但 `ratio` 为 0，同时计入 `coverage` 分母 —— 散点图的诚实性靠这个。

---

## 2. 新增端点

| 端点 | 用途 |
| --- | --- |
| `GET /api/events?from&to&type=failure,compaction,...` | ECG 标记层：`[{session_id, type, at, end_at, count, fill, detail, project}]`。失败=X 十字、压缩=琥珀箭头、retry/loop=`at`→`end_at` 横线（`count` 是连击数） |
| `POST /api/sandbox` | body `{from, to, swaps:[{from:"prov/model", to:"prov/model"}], cacheReadGain}` → `{current, projected, delta, deltaPct, byModel[]}` |
| `PUT /api/models/:key` | 价格/上下文覆盖（key 形如 `provider/model`），写入 `.data/model-overrides.json`；**要让历史成本生效需再调 `POST /api/refresh` body `{"full":true}`** |
| `POST /api/refresh` | body `{full: boolean}`。默认增量，`full:true` 走全量原子换名 |

---

## 3. 语义修正（数值会变，别当成 bug）

- **retry 不再虚报**：只有「前次失败或本次失败 + ≤15min 邻接」才算 retry；
  ≥3 次同签名连续重复算 `loop`（时间黑洞）。全库 retry 从 1345 降到 28，单会话峰值 344 → 7。
  `sessions` 表/接口新增 `loops` 字段。
- **`fill` 语义改为「发送时上下文占用」** = prompt_total / context_window，
  另加 `fill_after` =（prompt + output + reasoning）/ context_window。压缩点读数以前偏高，现在对齐真实触发条件。
- **compaction 事件带前后数字**：`detail = {reason, summary, before, after, delta, model}`，
  可以画出「压缩前 → 压缩后」的落差。
- **`files_changed` 补数**：v2 消息流没有 patch part 的会话回退读 v1 `part` 表，13 个会话有 diff 统计（原 12）。

---

## 4. 运行时变化

- **默认绑 `127.0.0.1:8787`**（原来是 `0.0.0.0` + 全开 CORS —— 载荷里有你的明文 prompt）。
  需要局域网访问用 `OSM_HOST=0.0.0.0 pnpm -F @osm/server dev`。
- **刷新是水位驱动的增量**：`MAX(消息表, session_v2.time_updated)` 没前进就直接跳过；
  真有变化时只重算脏掉的 session，实测 3563ms → **109ms**。所以 `/api/status` 里的 `materializedAt`
  不会每 2 分钟跳一次了，`mode` 字段会是 `full` / `incremental`。
- 新命令：
  - `pnpm -F @osm/server test` —— 离线 fixture 测试（25 项断言，不需要服务和网络）
  - `pnpm -F @osm/server test:smoke` —— 原来的 HTTP 冒烟（需要服务在线）
  - `pnpm -F @osm/server materialize --full` —— CLI 强制全量重建

---

## 5. 如果你直接查 `metrics.db`

表结构有以下变化（旧库已由全量重建替换）：

| 表 | 变化 |
| --- | --- |
| `flow` | `tokens` → `tokens_gen` + `tokens_cache_read`；新增 `peak_fill` |
| `heat` | 主键从 `(project, bucket)` 改为 `(project, day, hour)`，`day` = 本地零点时间戳 |
| `turns` | 新增 `bucket`/`day`/`hour`（预计算列，可直接索引）与 `fill_after` |
| `events` | 新增 `end_at`/`count`；`detail` 是 JSON，含 compaction 的 before/after |
| `tools` | 新增 `input_preview`（输入前 400 字符）与 `target_session`（task 子会话 id） |
| `sessions` | 新增 `loops`；`retries` 语义收紧 |

---

## 6. 验证基线

改动已全部实测（本机源库 535MB / 221 会话 / 24k 轮）：

- `tsc --noEmit` 通过；离线 ETL 25 项断言全绿；HTTP 冒烟 9 端点全绿
- 30 天窗口端点耗时：overview 15ms · ecg 3.5ms · sessions 3ms · heatmap 9ms · conversion 2ms
- 首页与 `web/dist` 静态托管正常（200）

前端如果因为 1.1–1.5 报错，先看这节和第 1 节；数值语义问题看第 3 节。
有问题直接找我。

---

## 7. 2026-10-19：切片型分析接口

前端改成单页仪表盘（一条全局切片 + 交叉过滤 + URL 深链）之后，为「一次请求拿到当前切片
的全部面板数据」重排了接口：

**新增**

| 端点 | 说明 |
| --- | --- |
| `GET /api/top/facets` | 过滤器取值（项目 / 模型 / agent / 工具）+ 时间跨度 + 总行数 |
| `GET /api/top/analytics?from&to&project&model&agent` | 当前切片的完整快照：totals、KPI 与上一等长窗口的对比、时间桶与模型堆叠、7×24 热力图、24 小时分布、效率百分位、模型 / 项目 / agent / 工具四张排行表、会话列表 |
| `GET /api/top/tool?name=` | 单工具的调用时间桶、延迟直方图、agent / 项目分布、参数签名聚类、最近错误、写回行数 |

`analytics` 里的 `totals.total` 仍是 input + output + cache_read + cache_write（不含
reasoning）；`sessions[]` 另外给出 `workflow` / `depth` / `childCount`，让会话树不必在
浏览器里重建。

**移除**

| 端点 / 模块 | 原因 |
| --- | --- |
| `GET /api/top/sessions` | 会话列表并入 `analytics`，同一份数据不再两次查询 |
| `GET /api/top/tools` | 工具排行并入 `analytics`，详情走 `/api/top/tool` |
| `GET /api/top/overview` | 由 `analytics` 取代（返回原始桶而不是预稀释的标签数组） |
| `server/src/metrics/trend.ts` | 自适应分桶改为 `analytics.ts` 的 `pickGranularity` + `seriesOf` |

`GET /api/top/session/:id/messages` 保留，`turns[]` 增补
`project / occupancy / contextWindow / fill / fillAfter / additions / deletions /
writeLines / hasError`，让会话详情不必再取一次列表。

**口径变更（数值会变，别当成 bug）**：统计单位从「窗口内活跃过的根会话 + 全部后代」的
祖先规则，改为「轮次自己的 `created` 在窗口内，且自己的 `project` / `model` / `agent`
命中过滤器」。由此 model / agent 维度才可过滤，聚合才可加；代价是跨窗口的长会话会落在
多个桶里。详见 `docs/opencode-top-parity.md`。

**验证基线**（221 会话 / 25,212 轮 / 25,532 次工具调用）：

- `pnpm typecheck` 两个包通过；离线 ETL 36 项断言全绿；HTTP 冒烟 9 项全绿
- `facets` 38ms / 5.5KB · `analytics` 全历史 340ms / 230KB · 7 天 76ms / 22KB ·
  3 天（小时桶）49ms / 13KB · `tool` 明细 71ms / 16KB

