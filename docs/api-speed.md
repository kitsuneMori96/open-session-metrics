# API 等待与输出速度设计

状态：已实现（Speed 屏，`/speed`）
范围：把**每一次 API 调用**的等待耗时与输出速度量化，按 provider × model 与时间段对比。

---

## 1. 结论先行

一个独立的 Speed 屏，每次 assistant 响应算一行，回答两个问题：

| 量 | 定义 | 单位 |
|---|---|---|
| **wait** | 调用发出 → 模型给出第一个输出证据 | ms |
| **speed** | 输出 token ÷ 等待结束后的响应时长 | tok/s |

两量都按 `provider × model` 聚合成 lane，按天出中位线。数据源决定口径：

- **OpenCode**（SQLite v2）：wait 是**首个输出证据**（首个 reasoning / 工具调用 / streamed 戳）
  减去消息创建时间；speed 用 `dur_ms − wait_ms` 作分母，即等待结束到响应收尾的整段。
  当前库 29 268 条 assistant 响应，29 265 条有精确 wait（99.99%）、26 432 条有 speed（90%）。
- **Qoder**（JSONL）：**一次响应落一行**，`dur_ms` 恒为 0–1 ms，没有任何流式时间戳。
  它的 wait 因此是**整轮往返**（提示 / 工具结果 → 响应落盘），精确但不是 TTFT；
  speed 没有可除的分母，Speed 屏直接显示 `—`，**不用 chars/s 估算**。

滚动汇总存 `roll_perf`（直方图桶）+ `roll_perf_day`（每日事实），十年窗口两个库都在 10 ms 内答完
（2026-11-03 实测 4.8 ms / 6.8 ms）。

---

## 2. 为什么不直接用"每轮耗时"

`turns` 上有三个不同的时间量，混用会把排队时间算成模型吞吐：

```
created ───────wait──────► 首证据 ──────────────── 响应收尾 ────────────────► completed
└──────────────────────────────── dur_ms ─────────────────────────────────────────┘
                           └──────────── speed 的分母 (dur − wait) ───────────┘
```

- `dur_ms` = 首事件 → 末事件，**包含等待**；
- `wait_ms` = 创建 → 首证据（OpenCode）或创建 → 落盘（Qoder）；
- speed 分母 = `dur_ms − wait_ms`，即等待结束后的整段响应。

用 `dur_ms` 作分母会把排队时间算进模型头上；而把分母截到"首个工具调用"也不行——
OpenCode 的 part 时间戳不可靠：实测一条 2 715 token 的响应，工具 part 在 493 ms 就创建了，
reasoning 的 `completed` 却落在 11 s 后，按首个工具截断会算出 5 500 tok/s 的假速度。
所以速度分母保留整段响应，**轮内工具执行时间也包含在内**，读到的是模型吞吐的下界：
95% 的响应带工具调用，任务越重，读数越低于纯解码速度。跨 lane 比较时看同源相对值。

---

## 3. 各源口径与实测覆盖

| 源 | wait 证据 | wait 覆盖 | speed 分母 | speed 覆盖 |
|---|---|---|---|---|
| OpenCode v2 | `min(reasoning.time.created, tool.time.created, time.streamed)` − `time.created` | 29 265 / 29 268 | `dur_ms − wait_ms`（等待后的整段响应） | 26 432 / 29 268 |
| Qoder JSONL | 合并时间线上"最新更早证据"（提示 / 工具结果 / 上一响应结束）→ 本响应 `ts` | 16 359 / 16 359 | 无（单行落盘，`dur_ms` ≈ 0） | 0 |

### 3.1 OpenCode

- 证据取三者的**最小值**：模型可能先冒 reasoning、也可能直接调工具，`time.streamed`
  在任何 part 戳缺失时兜底。
- 建库时把 `wait_ms` 直接写进 `turns`（`server/src/metrics/build.ts`），查询侧用
  `dur_ms − wait_ms`，不再另存跨度，避免两处定义漂移。
- 无证据（3 条，`output = 0` 的空响应）时 `wait_ms` 回退为整轮 `dur_ms`，
  Speed 屏的 `exact` 列会把它标成非精确；这类行没有 speed。
- `dur_ms − wait_ms ≤ 100 ms` 或 `output = 0` 的响应不进 speed 直方图（分母太小，速率无意义）。
- 速率超过 **1 000 tok/s** 的行同样剔除（全库 269 / 29 268，0.9%）。这类行的唯一时间戳落在
  响应收尾前几十毫秒——例如一条 2 727 token 的响应，工具 part 在 `completed` 前 134 ms 才创建，
  分母只剩一百多毫秒，除出来是五位数。没有模型解码超过 1 000 tok/s，坏的是分母，不是模型；
  剔除而不是截顶，免得把测量噪声伪装成一个真实读数。

### 3.2 Qoder

JSONL 里一个 assistant 响应落一行（多行会在合并时按 message.id 收成一轮）。实测 2026-11-03 的
16 359 条 assistant 响应全部单行落盘，`dur_ms` 全在 0–1 ms——**不存在流式时间戳**，所以：

- wait 精确：`source-qoder.ts` 的 `waitPass()` 在父子代理合并后的时间线上走一遍，
  每个响应的 `ts`（首行落盘时刻）减去最新更早证据;
- speed 不可算：没有"首个 token → 写完"的跨度。早期想用 chars/s 代理，
  但那测的是"整轮往返内写了多少字"，与 OpenCode 的写作速度不同量纲，
  对比会失真，因此 speed lane 对 Qoder 留空而不是估算。
- Qoder 的 wait p90 会到十分钟量级（Qwen3.8-Flash lane 实测 604 s），这是整轮往返的
  真实分布，包含排队与长时间思考，不是解析错误。

---

## 4. 存储：直方图滚存

`roll_perf`（每 `day × provider × model × kind × bin` 一行计数）与
`roll_perf_day`（每日 calls / exact_waits / wait_sum / output / chars）挂在现有 rollup 机制上：

- **等待直方图**：对数阶梯 `ladder.ms`（128 bin/octave），可还原 p50 / p90 / max；
- **速度直方图**：线性阶梯 `ladder.rate`（0.25 tok/s 一档），分位数取桶下沿；
- `kind = 'wait' | 'speed'` 两张直方图共用一张表；
- 窗口跨越整天时读 rollup，切成两端的边缘日回 `turns` 现算（`perfBinsSource` / `perfDaySource`）；
- `roll_perf` 不带 project / agent 列，所以切片带这两个维度时整窗回原始 `turns`
  （`rawPerfBinsSource`）；`model` 维度在 JS 里过滤，因为每日行只有几条；
- `ROLL_VERSION` 与 `SCHEMA_SIG` 任一变化都会触发全量重建，直方图随 `turns` 一起重算。

speed 取的是**逐调用速率的中位数**（先算每次调用的 tok/s，再取分位），
不是"总 token ÷ 总时长"——后者会被一两次超长调用拉偏。`speedMean` 曾按整轮分母实现过，
口径改变后已删除。

---

## 5. API

```
GET /api/top/speed?from=<epoch ms>&to=<epoch ms>[&project=][&model=][&agent=]
```

```ts
interface SpeedRow {
  provider: string; model: string;
  calls: number; exactWaits: number;      // calls 有可测 wait 的响应数
  waitP50: number; waitP90: number; waitMax: number;
  speedP50: number | null;                // null = 该源没有写作段
}
interface SpeedPoint {                    // 每个时间桶 × lane 一条，供热力图和聚焦带
  at: number;                             // 桶起点（ms）；空桶不出现
  provider: string; model: string;
  calls: number;
  waitP25: number | null; waitP50: number | null; waitP75: number | null;
  speedP25: number | null; speedP50: number | null; speedP75: number | null;
}
interface SpeedResponse {
  rows: SpeedRow[]; points: SpeedPoint[];
  axis: number[];                         // 窗口内每个桶起点，含空桶——热力图的列轴
  gran: Granularity;                      // 自动解析后的单位
}
```

桶宽走全站同一套 `pickGranularity`（≤3 天按小时、≤180 天按天、更长按周，并粗化到
≤200 列）；`?gran=` 可覆盖。日/周/月等桶走 `roll_perf` 滚存，小时与 5 分钟桶直接扫
`turns.created`——滚存只存到天。`axis` 由服务端给出，前端不再重复推日历边界。

`calls` 统计的是 `COALESCE(wait_ms, dur_ms, 0) > 0` 的 assistant 响应——
Qoder 单行响应的 `dur_ms` 为 0，若按 `dur_ms > 0` 过滤会丢掉 95% 的调用（已修正）。

---

## 6. Speed 屏

`web/src/screens/Speed.tsx`，导航键 `5`：

- 顶栏：`wait` / `speed` 切换（源没有写作段时 speed 禁用）+ 窗口标签；
- 左侧：四个读数（calls / exact / lanes / buckets）+ lane 表
  （model、provider、calls、exact %、wait p50 / p90、speed p50）；
  少于 10 次调用的 lane 变暗，点一行即选中该 lane 的聚焦带；
- 右侧：**热力矩阵 + 聚焦带**。
  - 矩阵：行是 provider × model，列是时间桶，颜色是该桶的中位数——
    一条线画 19 条 lane 会互相穿插，共享线性 y 轴还会被一个慢夜压平；
    矩阵用位置回答"周二晚上哪家变慢了"。颜色在 **p95 处饱和**（极值仍在
    tooltip 里给真实数字），**空格表示这一桶没有调用，不是 0**。
    点格子 = 聚焦该 lane 并放大到这一桶（单位降一档：≤3 小时按 5 分钟、
    ≤3 天按小时、≤半年按天、更长按周），点 lane 名只聚焦；
  - 聚焦带：所选 lane 的 p25–p75 区间带 + p50 线 + 每桶调用数条带。
    中位数持平而 p75 翻倍就是退化，只有带宽能看出来；断档画成断开，
    不跨越没运行的时段插值。

---

## 7. 会话时长的校准

同一套证据顺手修正了 Sessions 屏的"时长"：`sessions.msg_span_ms` =
**最后一条响应 completed − 第一条消息 created**，即真实的 API 消息跨度，
而不是文件首尾时间（后者会被空闲与关闭时间拉长）。Sessions 表的 span 列显示的
就是这个值，排序也走它（`SESSION_ORDER_COLUMN.span = "msgspan"`）。

---

## 8. 验收门

| 门 | 结果（2026-11-03） |
|---|---|
| 20 条随机 OpenCode 响应与源库逐条对照（wait / dur） | **20 / 20 一致** |
| ETL：rollup 与原始扫描在五种切片下逐 lane 相等 | 通过（`speed lanes agree with the raw scan` ×5） |
| ETL：每条 assistant 调用只落一个 lane | 通过 |
| ETL：有写作段的 lane 必有 speed | 通过 |
| Qoder：calls = assistant 响应数 | 16 359 / 16 359，exact 100% |
| OpenCode：wait 覆盖 | 29 265 / 29 268（3 条空响应） |
| OpenCode：speed 覆盖 | 26 432 / 29 268（>1 000 tok/s 剔除 269 条） |
| 十年窗口响应时间 | OpenCode 4.8 ms / Qoder 6.8 ms |
| 三个月窗口响应时间 | 3.4 ms |
| 全量重建 | OpenCode 245 会话 / 31 495 轮 ≈ 13.5 s；Qoder 50 会话 / 17 645 轮 ≈ 11.7 s |

复现：`pnpm -F @osm/server test`（四个套件）逐条打印上述 gate。

---

## 9. 已知边界

- **wait 的含义随源不同**：OpenCode 是 TTFT 近似，Qoder 是整轮往返。两者放在同一张表里，
  provider 列就是口径的提示，比较跨源速度时应只看 wait 的趋势与同源内的相对值。
- **speed 是分位数的近似**：直方图桶宽 0.25 tok/s，p50 取桶下沿，误差在 0.25 tok/s 内。
- **speed 含工具时间，读作模型吞吐的下界**：分母是"等待结束到响应收尾"的整段，轮内工具执行
  也计入。任务越重（工具越多、执行越久），读数越低于纯解码速度；跨 lane 比较时看同源相对值。
  速率 >1 000 tok/s 的行按坏分母剔除，不进入直方图。
- **Qoder 的 speed 永远为空**：除非 Qoder 开始持久化流式时间戳，否则不做估算。
