# 数据源切换设计

状态：已实现
范围：把「看哪一份会话数据」做成面板的最高一层作用域，两库并存、一次选定、随时切换。

---

## 1. 结论先行

数据源**不是筛选维度**，是作用域。它比路由更高：先决定读哪个库，才谈得上哪个页面、
哪个时间窗、哪个项目。三条判据：

1. **不可组合**：`project=holo AND src=qoder` 不是「更窄的视图」，而是另一个世界；两库的
   session id、project 名、模型别名互不相交，交叉筛选没有意义。
2. **不可叠加**：facet 可以一次选三个，来源只能有一个。把它放进 `✕ clear filters` 能清掉的
   那一排，等于告诉用户「它是个过滤器」。
3. **不可链接**：`/overview?src=qoder` 是一条指向别人数据的链接，而且每个 `href` 都要背着它。

所以：**不写 URL、不进 queryKey、不进 href**。它存活在 `localStorage`，随请求头过去。

---

## 2. 页眉：换掉一个词，不加一行

层级多了 4 层（source → route → window/gran → facet），像素上只多了一个字符。原本那一栏
显示 `mode · 时间`（`full · 14:32`），`mode` 只是「上次是全量还是增量」，让位给 source，
自己进 tooltip。

```
BEFORE  h=36px
  ◆ OSM  1 Overview  2 Sessions  3 Tools  4 Compare      ⌕ search sessions, tools, text [/]  ↻ sync  full · 14:32

AFTER   h=36px
  ◆ OSM  1 Overview  2 Sessions  3 Tools  4 Compare      ⌕ search sessions, tools, text [/]  ↻ sync  ▾ opencode · 14:32
  └─────────────── 不动的 51 字符 ───────────────┘                    └ actions ┘   └── 换掉的那一栏 ──┘
```

净增：一个 `▾`（约 6 px）+ 一个词的长度差（`full` → `opencode`，约 26 px），吃的是右侧
`flex-1` 的余量，中间那段搜索框一个像素都不动。高度 **0 px**。

整屏预算不变：

```
 36 px  TopBar    ◆ OSM  1 Overview  2 Sessions  3 Tools  4 Compare   ⌕ search … [/]  ↻ sync   ▾ opencode · 14:32
  1 px  hairline
 28 px  SliceBar  window 24h 7d 30d 90d all · 14:32→15:32  by auto │ project model agent   store 232 · 29 273 · 29 551
  1 px  hairline
        main      ┌ scope ────────────────────────────────────────────────────────────┐
                  │  <Routes> re-mounts · query cache rebuilt under this key           │
                  │  same screens, other store — nothing else changes                  │
                  └────────────────────────────────────────────────────────────────────┘
 24 px  StatusBar 1–4 go · / search · r sync · esc reset
```

SliceBar 一行都没改：来源不许出现在 `project model agent` 那排，右端 `store …` 只是数字变了。
StatusBar 的提示行也不加字——不设 source 专用快捷键（`1`–`4` 已被路由占满）。

## 3. 点开：唯一的浮层，常态 0 px

```
                                  ┌─ SOURCE ─────────────────────────────────────────────────────┐
                                  │  ◆  opencode                    232 ses · 29 273 turns       │
                                  │     └ ~/.local/share/opencode/opencode.db                    │
                                  │  ◌  qoder                        24 ses · 6 693 turns         │
                                  │     └ ~/.qoder/projects                                      │
                                  ├──────────────────────────────────────────────────────────────┤
                                  │  window and filters stay per source                          │
                                  └──────────────────────────────────────────────────────────────┘
```

- 每个来源两行：名字 + 存量，下一行是它**从哪读**。只有计数没有来源路径，等于传闻。
- 标记只用已有字形：`◆` 当前、`◌` 未建、`·` 可选/不存在（都在 `index.css` 的 3 KB symbol 子集里，
  不让系统自造字符）。
- 宽度 286 px，右缘对齐控件；`ink` 入场 170 ms，`▾` 用 `turn` 120 ms 翻转。
- 菜单永远不常驻：**常态 0 px，需要时 286 px**。

## 4. 三种状态，以及一个刻意的「无状态」

```
单源机器        ▾ opencode · 14:32          ← 只有一份数据：降级为纯文本，无 ▾，不可点
源未安装        ·  qoder   not found        ← 菜单内该行灰、不可点
库未建立        ◌  qoder   not built        ← 切过去即触发首次物化，控件 Pulse
就绪            ◆  qoder · 14:41            ← 服务端 materializedAt
```

单源机器上不假装可点，是这套控件的底线：没有第二个选项时，它就不是控件。

**未做百分比进度**：全量物化 1.4–4.7 秒，造假数字比不显示更糟。这段时间里 `◌ … first build`
加 Pulse 就够，屏幕上是骨架而不是数字。

## 5. 切换时序：一帧都不能错

```
frame 0   ▾ opencode · 14:32    │  store 232 sessions · 29 273 turns · $
frame 1   ▾ qoder · ◌ first build│  store ── ── ──  (骨架不动，数字位 Hold)
frame 2   ▾ qoder · 14:41       │  store 24 sessions · 6 693 turns · cr
```

一次提交里做完四件事，顺序不能换：

1. 记住当前源的切片（`localStorage`）；
2. 用新库的 `unit` 调 `setMoneyUnit`——**在挂载之前**；
3. `commitSource()` 写模块态，随后 `setClient(makeClient())` 整棵缓存作废；
4. `navigate` 到新源自己的切片（会话详情页会退回列表，因为 session id 属于某一个库）。

单位没有放在 `useEffect` 里：effect 在子组件已经印出数字之后才跑，会给积分库画一帧 `$`。
它在 `Shell` 的渲染体里、子组件渲染之前写入。这是这套「模块级单例 + 60 个调用点」唯一的
正确时机。

## 6. 两库并存：存储层

```
DATA_DIR/
├── metrics.db            # OpenCode（沿用历史名，升级不触发 232 会话重建）
├── metrics-qoder.db      # Qoder（第一次切过去时才建）
└── model-catalog.json    # 价目缓存，两库共用
```

- `store.ts` 从单例改成 registry：每个源各持一个 handle、一个 watermark、一个 `.next` 交换文件。
- 句柄按源登记（不是按路径），另一个进程 `pnpm materialize --source qoder` 换文件时，
  只关掉真正过期的那一个。
- `build(db, { kind })` 显式指定读哪个源；`openSource(kind)` 之外，ETL 上游一行未改。
- 启动只物化**默认源**；2 分钟一轮的增量刷新只跟随**已经存在的库**，「从未建过」保持为
  一次明确的动作。

两个库装的东西也不一样，这是**源的能力**，不是展示偏好。Qoder 的一轮只有上下文占用一个数
（`context_usage_ratio × contextWindow`），没有 output / cache / reasoning，所以
Overview 的 `stack by` 在它上面只剩 `model` 与 `cost` 两个选项，默认 `model`——六个模型
铺在一条时间轴上有信息量，一条 `input` 带子配四行空图例没有任何信息量。服务端对 `turns`
做一次 `LIMIT 1` 探测，把结论作为 `tokenClasses` 同时写进 `/api/status` 与 `/api/sources`：
后者是启动时先于首帧解析的，所以默认值不会先画 `class` 再翻成 `model`。

## 7. API 契约

| 请求 | 说明 |
| --- | --- |
| 任意 `/api/*` + 头 `x-osm-source: qoder` | 读该源的库；缺省用服务端默认源 |
| `?src=qoder` | 同上，只为 curl / 调试保留，前端不用 |
| `GET /api/sources` | 菜单的全部数据：`available`（本机是否存在）、`ready`（是否物化）、`unit`、`tokenClasses`（是否记录 token 分类）、路径、计数 |
| `POST /api/refresh` | 物化**请求头声明的那一个**源；库不存在时自动走全量 |
| 未物化的库 | `/api/status` 回 200 + `ready:false` + 全零计数；分析类接口回 503 |

`?src=` 不进前端，是因为作用域不该可链接；`/api/status` 对未建库回 200，是因为「这个库还没建」
是页眉要画的状态，不是错误。

## 8. 切片归属

每个源各记一份切片，切回来还是原来的窗口与筛选：

```json
// localStorage["osm.slice"]
{ "opencode": "?range=90d&project=holo", "qoder": "?range=7d" }
// localStorage["osm.source"]
"qoder"
```

理由：数据源是作用域，不是重置开关。切一次就回到 24h，等于每换一次库要重点三次。

---

## 9. 验收门（本机实测，2026-10-24）

| # | 门 | 结果 |
| --- | --- | --- |
| 1 | 页眉高度不因新增层级变化 | 36 px，未变 |
| 2 | 单源机器不出现伪控件 | 降级为纯文本，无 `▾` |
| 3 | 未建库时状态可读 | 菜单 `◌ not built`，切过去 4.7 s 内建好 |
| 4 | 切源不重物化已有库 | 切回 OpenCode 只走 823 ms 增量 |
| 5 | 单位随库走，无 `$`→`cr` 闪帧 | Qoder 四屏 + transcript 均 0 个 `$`；OpenCode 仍为 `SPEND`/`$` |
| 6 | 切片按源保留 | `opencode` 停在 `?range=90d`，`qoder` 为默认 `24h`，往返一致 |
| 7 | 作用域不进 URL | 切源后 `location.search` 只有切片参数 |
| 8 | 会话详情不跨库 | 在详情页切源 → 退回 `/sessions` |
| 9 | `?src=` 仍可调试 | `curl /api/status?src=qoder` 返回 24 会话 / 6 693 轮 / `unit: credit` |
| 10 | 未建库不报错、不建空库 | 分析接口 503，`hasStore("opencode")` 保持 false |
| 11 | 源的形状决定默认，不是样式 | qoder：`stack by` 只有 `model` / `cost` 且默认 `model`；opencode：三选一、默认 `token class` |

## 10. 有意不做的

- **不做切换动画**：换的是数据不是布局，骨架不动，只有数字 `Wipe` 170 ms。
- **不做来源筛选条**：那是把作用域降格成 facet（见 §1）。
- **不做 URL 参数**：见 §1 判据 3。
- **不在启动时建第二个库**：给从不看 Qoder 的用户省掉每次启动的几秒。
- **不在菜单里显示进度百分比**：真实的构建只要几秒，假进度是噪音。
