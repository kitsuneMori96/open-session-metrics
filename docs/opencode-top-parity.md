# 与 opencode-top 的对照

`opencode-top` 是终端里的三屏程序（Sessions / Tools / Overview）。这里保留它的**功能清单**
——每个数字、每个面板都还能找到对应物——但不再一比一复刻屏幕布局：终端受限于「一屏一列」，
所以把「选中一个会话再看它的正文」拆成了两个屏；浏览器可以把这件事做成一页。

## 屏幕 → 路由

| opencode-top | 本项目 | 说明 |
|---|---|---|
| 三个屏，`Tab` / 数字键切换 | `/overview` `/sessions` `/tools` `/compare` | 同一套内容，加一个并排比较屏 |
| Sessions 左栏（会话树 + 搜索） | `/sessions` 的表格 | 树用「展开行」表达：根会话下挂子代理会话，按 `parent_id` 缩进 |
| Sessions 右栏 Stats 页签 | `/sessions/:id` | Token 明细、形状、上下文条、MODELS / TOOLS、AGENT CHAIN |
| Sessions 右栏 Messages 页签 | `/sessions/:id` 的正文面板 | 同一批行（轮次头 / 工具 / 回显 / 正文 / 推理），改成虚拟滚动 + 折叠 |
| Tools 左栏列表 + 右栏详情 | `/tools` 与 `/tools/:name` | 同一张表与同一个详情，靠路由切换而不是 `Tab` |
| Overview 三列（Totals / 趋势 / 排行） | `/overview` | 同样是「汇总 + 时间趋势 + 排行」，但排成响应式栅格并互相联动 |
| 全局过滤（时间范围 + 项目） | 顶部切片条 | 时间范围改成 6 个预设 + 手动框选，维度加 model / agent |

## 端口径差异（有意为之）

**切片规则。** opencode-top 的 Overview 是「祖先规则」：先按 `project` 与 cutoff 选出
窗口内活跃过的**根会话**，再补上它们的全部**后代**会话，最后只统计 cutoff 之后的轮次。
父会话静默时，挂在它下面的子会话也一并退出统计；而且这个规则下「按 model / agent 过滤」
没有意义（模型是轮次的属性，树是会话的属性）。

本项目改成**轮次自身规则**：统计「自己的 `created` 在窗口内，且自己的
`project` / `model` / `agent` 命中过滤器」的助手轮次。于是：

- 三个维度可以任意交叉过滤，聚合是可加的（各维度的和等于总数）；
- 代价是一个横跨窗口边界的长会话会出现在多个时间桶里——按天看时这是对的，
  按「这次工作」看时不是。

`turns` 表里的 `created` 是**轮次自己的**时间戳，不是会话的 `updated`，所以这一口径不需要
解析父子树。

**其余口径照抄**：Token = input + output + cache_read + cache_write（不含 reasoning）、
`context` = input + cache_read + cache_write、`output_rate` 取轮次中位数、diff 只数 hunk 内的
`+`/`-`、`write_lines` 单独记。理由见 README 的「指标定义」。

## 呈现风格的差异

- 深色 TUI 换成纸白 + 墨蓝；`▓░` 换成实心条；`◆`、`╰─`、`▶`、`✓/◌` 等符号保留，失败标记用 `×`（U+00D7，字形在本体等宽字体里，`✗` 会被浏览器替换成别的字体）
  （等宽字体下语义清楚）。
- 键位鼠标优先，键盘等价键保留并在状态栏提示。

## 浏览器带来的新动作（原版没有的能力）

终端没有指针、没有可寻址的视图。这几件事只有 Web 能提供，所以直接做进了交互里：

| 动作 | 结果 |
|---|---|
| 在时间序列上拖拽 | 提交一个新的绝对窗口（`from` / `to` 进 URL），整页重算 |
| 点排行条 | 按该维度交叉过滤（再点一次取消） |
| 点散点 | 进该会话详情；hover 排行榜某行时高亮对应的点 |
| 在正文面板里框选轮次 | 正文只留这几轮 |
| `/` 或 `⌘K` | 命令面板：跳转、切窗口、套过滤、全库正文检索 |
| 复制地址栏 | 切片、过滤、对比对象、散点坐标轴都在 URL 里，链接可复现 |

## 落点

| 原版 | 本项目 |
|---|---|
| `core/session.ts` 的 `getSessionTokens/Cost/Duration/OutputRate` | `sessions` 表在物化时算好，接口直接返回 |
| `computeOverviewStats()` 在内存里遍历 | `server/src/metrics/analytics.ts` 用 SQL 聚合（`dashboard` / `toolDetail` / `facets`） |
| `buildTrendBuckets()` | `analytics.ts` 的 `pickGranularity` + `seriesOf`（小时 / 天 / 周自适应，按窗口长度选桶宽） |
| `groupSessionsToWorkflows()` / `buildAgentNode()` | `analytics.ts` 的 `sessionsOf`（`workflow` / `depth` / `childCount` 在服务端算） |
| `MessagesPanel.buildLines()` | `web/src/lib/transcript.ts` 的 `buildRows()`（同样六种行、同样 40 行回显上限） |
| `BarChart` / `ErrBar` / `SuccessBar` | `components/charts/ranks.tsx`、`components/ui.tsx` 的 `RateBar` / `SegBar` |

只描述历史状态的文档：[docs/backend-refactor.md](backend-refactor.md)（2026-10 后端重构，
之后的接口见 README 的 API 表）。
