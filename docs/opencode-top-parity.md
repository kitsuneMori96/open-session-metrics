# opencode-top 对位设计

我们保留自己的**呈现风格**（毫米网格纸、墨蓝、细线、等宽微字），把**功能内容**换成
`opencode-top` 的三屏结构。这是一次减法：原来的 ECG / 上下文泳道 / 解剖视图全部退场，
界面只剩三屏，每屏的每一个数字都能在 TUI 原版里找到对应物。

## 数据来源的差别

opencode-top 每次刷新都直接读 `opencode.db`，把 `session_message` / `part` 的 JSON
在进程里解成 `Session → Interaction → MessagePart`。我们的约定是**不实时解析源库**，
所以：

| opencode-top | 我们 |
|---|---|
| 进程内解析 sqlite | 物化进 `metrics.db`（`turns` / `tools` / **新增 `parts`** / `sessions`） |
| `interactions` = 全部 message | `turns`（`role='assistant'` 即 interaction，`text` 已存） |
| `parts` = message.data.content[] | 新增 `parts` 表，逐条落库（有长度上限） |
| `getSessionTokens()` 在 UI 里累加 | 累加逻辑放服务端 SQL + 客户端 `derive.ts`（与 `core/session.ts` 一一对应） |
| `projectName` = project 表名 | 我们的 project 由工具触碰路径推断（更贴近真实仓库） |

落库上限：text/reasoning 2000 字符、tool input 1500、tool output 3000。实测按此上限
预估新增约 67 MB（源库 `session_message` 共 234 MB），是可接受的代价，换来消息面板
可以完全离线渲染。

## 三屏

### 1 Sessions（会话）
- 左栏：搜索框 + 代理树。每个 workflow = 一个根会话及其子代理会话；行显示
  `▸/▾` 展开态、缩进、标题、`MM/DD HH:mm`、token、成本。
- 右栏两个页签 `Stats | Messages`：
  - **Stats**：标题/项目、`Tokens/Cost/Duration/Rate/Calls`、context 进度条、
    `MODELS`（前 3，含调用次数与 token）、`TOOLS`（前 3，成功/调用）、
    `AGENT CHAIN`（可折叠，`├─/└─` 树，`[agent] title`、token、成本）。
  - **Messages**：计行条（`起–止/总 · 游标 token/总 token · 过滤 · 匹配 n/m · N turns`）
    加六种行：turn 头（模型、agent、↓输入 ↑输出、耗时、时刻）、tool
    （`✓/✗/◌` + 名称 + 标题 + 展开箭头 + 耗时）、tool 展开后的 `input` 参数与
    `output` 前 40 行、助手正文、reasoning 折叠头（`⚡ [reasoning] ▶ 预览 (Nc)`）、
    reasoning 展开正文。
  - 过滤循环 `all → errors → tools → text`；`/` 搜索、`n/N` 跳匹配。

### 2 Tools（工具）
- 顶部排序键 `calls / failures / avg-time`。
- 左：工具列表（调用数、失败数）。
- 右：选中工具的 `Total calls / Successes / Failures / Avg time`、成功率条、
  `RECENT ERRORS`（最多 3 条）。

### 3 Overview（总览）
- 过滤：`today / last 7d / last 30d / last 90d / all time`，项目过滤。
- 三列：左＝Totals（总 token / input / output / cache r/w / 总成本）+ token 趋势柱图
  （自适应 小时/天/周，含峰值与轴）+ 会话趋势柱图 + 24 小时活跃柱图；
  中＝按 agent 的工具错误条 + Top tools（√ 缩放条）；
  右＝Projects（会话数 + 成本）+ 工具平均耗时 Top5 + Models（调用数 + token）。

## 我们保留的风格差异
- 深色 TUI 换成纸白 + 墨蓝；`▓░` 换成实心条；`◆`、`╰─`、`▶` 等符号保留（等宽字体下语义清楚）。
- 键位映射为鼠标优先，键盘等价键保留并在状态栏提示。

## 落点

| 原版 | 本项目 |
|---|---|
| `core/session.ts` 的 `getSessionTokens/Cost/Duration/OutputRate` | `sessions` 表在物化时算好，接口直接返回 |
| `computeOverviewStats()` 在内存里遍历 | `/api/top/overview` 里用 SQL 聚合，再按同口径拼装 |
| `buildTrendBuckets()` | `metrics/trend.ts`（小时 / 天 / 周自适应，标签按 `ceil(n/8)` 稀释） |
| `groupSessionsToWorkflows()` / `buildAgentNode()` | `web/src/lib/derive.ts`（子节点按最近活跃排序，workflow 按含子代理的最新活跃排序） |
| `MessagesPanel.buildLines()` | `web/src/lib/derive.ts` 的 `buildLines()`（同样六种行、同样 40 行回显上限） |
| `BarChart` / `ErrBar` / `SuccessBar` | `components/BarChart.tsx`、`components/ui.tsx` 的 `SegBar` / `SplitBar` |

## Web 端的几处适配

原版是终端全屏程序，没有鼠标和异步加载，几处行为按浏览器的习惯改写，内容不变：

- **`/` 搜索**：左栏即时按标题 / 项目 / 首条提问过滤，同时对 `/api/top/search` 做一次防抖
  的全库正文检索，把命中会话列在过滤结果上方（`n` / `N` 在命中之间跳）。原版是在内存里
  遍历所有 interaction 的正文；我们不在浏览器里放全库正文，所以这一步走了接口。
- **Messages 面板**：正文不再手工按列宽折行，交给 CSS 换行；游标仍按「逻辑行」移动，
  计行条的行号范围由容器实测得出。
- **Stats 面板**：窗口够宽时 `STATS / MODELS / TOOLS` 与 `AGENT CHAIN` 并成两列，
  窄窗口自动叠回一列；字段与顺序不变。

