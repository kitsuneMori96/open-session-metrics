# Qoder CLI 数据源设计

状态：已实现（v0.2.0 起；0.3.0 项目改名 Open Session Metrics）
范围：把 Qoder CLI 的本地会话接入 OSM，作为 OpenCode SQLite 之外的第二类数据源。

---

## 1. 结论先行

Qoder CLI **没有会话数据库**。会话以 JSONL 写在 `~/.qoder/projects/<encoded-cwd>/<sessionId>.jsonl`，
同目录下的 SQLite（`shared_client/cache/db/local.db`、`atlas.db`）是 IDE 缓存与代码索引，与会话无关。

接入方式因此是**新增一个 JSONL 数据源适配器**，而不是读数据库：

```
Qoder JSONL ──► QoderSource ──► SrcSession / SrcTurn / SrcTool ──► metrics-qoder.db ──► 现有 API/UI
                 (本设计)          (与 SourceReader 同构)
```

适配器与 `SourceReader` 实现同一个 `SourceLike` 接口，`build.ts` 之后的所有流程（聚合、rollup、
ECG、transcript、API）保持不变。

---

## 2. 实测证据（本机，2026-10）

| 项 | 值 |
|---|---|
| 会话文件 | 24 个主转录 + 8 个子代理转录，13 个项目目录，67.3 MB |
| 时间跨度 | 2026-10-11 → 10-24 |
| CLI 版本 | 1.1.68 – 1.1.76（13 天内 9 个版本） |
| assistant 事件 | 14 244 |
| 合并后消息（`message.id`） | **6 204**（主转录 6 073 + 子代理 131），id 全局唯一 |
| 其中模型响应 | **6 183**（另 21 条 `<synthetic>` 是"积分耗尽/无法连接"提示，按系统消息入库） |
| 用户提示 | 489 |
| 有 usage 的轮次 | 6 182（21 条 `<synthetic>`、1 条空模型，均 0 积分） |
| 积分合计 | **689.965** |
| `credits` 为零 / 为负 | 21 / 0 |
| `original_credits != credits` | 0 |
| 工具调用 | Bash 2 543 / Edit 943 / Read 731 / mcp_call 625 / Write 222 / Grep 134（另含子代理） |
| 工具结果 | 6 449 成功 / 316 失败（4.7%） |
| token 字段 | `input/output/cache_*` **恒为 0** |
| `context_usage_ratio` | 0.027 – 0.930，中位 0.492 |
| `contextWindow` | `runtime-config` 只出现 `null` 与 `200 000` 两种；比例的分母是模型的 `max_input_tokens`，见 §5.1 |
| 压缩（上下文回落 > 50 000 tok） | 43 次 |
| 遥测 `hook_input.model` | `Qwen3.8-Flash` 为主，`DeepSeek-Flash` 见于 2 个会话 |
| 空会话 | 6 个（启动后无模型响应：0 轮、0 积分） |

> 早期一次统计给过 30 会话 / 6 009 轮 / 678.023 积分：它把 `subagents/` 漏掉、又混入了
> 部分被拆分的事件。以上数字是当前解析器的实测结果，也是验收门的基准。

---

## 3. 数据源

### 3.1 transcript（指标与正文）

`~/.qoder/projects/<encoded-cwd>/<sessionId>.jsonl`，每行一个事件：

| 事件 | 用途 |
|---|---|
| `assistant` | 模型输出；`message.content[]` + `message.usage` |
| `user` | 用户提示，或 `tool_result`（含 `is_error`） |
| `ai-title` | 会话标题 |
| `workspace-directories` / `cwd` | 工作目录 |
| `runtime-config` | `contextWindow`（`null` = 没在模型选择器里钉窗口，比例分母回落到模型目录） |
| `active-leaf` | UI 导航指针，**不用于分支重建** |
| `system` / `attachment` / `last-prompt` | 辅助信息，可选 |

### 3.2 遥测（仅用于模型名）

`~/.qoder/logs/sessions/<encoded-cwd>/<sessionId>/segments/*.jsonl`：

- `model.request.started` / `model.response.completed` 带 `data.model`（别名）与 `request_id`；
- `hook.started` 的 `data.hook_input.model` 带真实模型名，但**与别名不同框**；
- 因此真实名只能做**会话级**映射（见 §6），不能逐请求 join。

### 3.3 子代理转录（必须合并，不能当独立会话）

委托给子代理的会话会在同目录下多出：

```
<encoded-cwd>/<sessionId>/subagents/agent-<name>-<hash>.jsonl
```

这些文件里每一行的 `sessionId` 仍是**父会话 id**，积分也记在父会话账上。
真实语料里是 8 个文件、131 轮、8.708 积分（占总量 1.3%）。把它们当独立会话会
凭空多出 8 个会话；整个忽略则每一笔委托成本都凭空消失。规则是：
**按会话 id 分组，父转录与它的子代理转录一起解析后合并**（轮次按时间重排、
`message.id` 去重、积分与上下文相加）。

### 3.4 标题：转录优先，桌面索引补缺

标题只用于展示，不参与任何指标，来源按优先级取：

1. 转录里的 `ai-title`（qodercli 自己生成的标题）；
2. Qoder Desktop 的 `main.sqlite` → `chat_sessions.title`（`deleted_at IS NULL`）；
3. `last-prompt` 的首行，截断 120 字符。

Qoder Desktop 是 qodercli 的 Electron 壳，会话本来就在同一棵 `projects/` 转录树里，
所以**它不是独立数据源**，`main.sqlite` 只当标题旁路：不增删会话，不提供轮次或积分。
WSL 下该库位于 Windows 盘（DrvFs），WAL 锁无法就地获取，读取前复制
`main.sqlite` + `-wal` + `-shm` 到 `<DATA_DIR>/qoder-title-snapshot/`，读完即删；
标题表按库文件的 mtime/size 缓存，进程内只解析一次。

### 3.5 跨 OS 的转录树：一个源、多个根

qodercli 把转录写到**运行它的那一侧**的数据根。WSL 机器因此同时有两类树：

```
/home/<user>/.qoder/projects/<encoded-cwd>/<sessionId>.jsonl          # WSL 侧
/mnt/c/Users/<name>/.qoder/projects/<encoded-cwd>/<sessionId>.jsonl   # Windows 侧
```

它们是同一个账号、同一个积分池，还共用同一个 `main.sqlite` 标题索引，所以
**不另立数据源**：`QODER_PROJECT_ROOTS` 把这些根并列交给同一个 `QoderSource`。

实测差异（2026-11-03，Windows 侧 3 个会话）：

- schema 完全一致：`workspace-directories` / `runtime-config` / `user` / `assistant`
  同款，`usage` 带 `credits` 与 `context_usage_ratio`（249 条响应、28.717 积分）；
- `runtime-config.contextWindow` 为 `null`——与 WSL 侧同一副面孔，分母仍取钉住的
  模型窗口，不需要新分支；
- 工作目录是 Windows 绝对路径（`D:\Download\Code\qoder通用工作区`），`projectName`
  按 `[\\/]` 切段就得到泳道名；工具入参里的路径也是盘符形式，`pathsOf` 必须认它，
  否则这些会话的改动文件数恒为 0；
- 3 个会话 id 与 WSL 侧的 77 个无重叠，**当前不会双计**。

两条纪律：

1. **同 id 出现在多个根 = 副本，不是两半**。Qoder 会把会话在树之间迁移（迁移前先留
   `session-migration-backup-*` 再改库），此时两份文件讲的是同一个会话。取"文件更多、
   其次 mtime 更新"的那一棵，另一棵整体丢弃——按行合并会把同一轮计两次。
2. **就地读，不做镜像**。DrvFs 上全树扫描 + 全文读实测 271 ms（3 文件 2.5 MB），
   mtime 精度到 ns，增量水位照常工作；副本只会多出"哪份是真的"这个问题。
   `main.sqlite` 是例外：WAL 锁取不到（原地 open 直接 `disk I/O error`），必须走 §3.4 的快照。

`OSM_QODER_HOME` 显式设置时**只用这一棵树**：测试与单机安装不能因为扫到 `/mnt/c`
就改变结果。

Windows 侧的 `logs/sessions/` **不读**（§3.2 的模型真实名仍只从 WSL 侧遥测取）：那一边
目前只有 `session.config.loaded` 一个空事件，没有 `model.request.started`，喂进去只会
把证据更少的名字当成权威。

Windows 侧还在写的会话是另一种风险：一次读可能正好截在半个 JSON 行上。`/mnt/<盘>/`
下的读取因此丢掉最后一段没有换行结尾的内容，不硬拼半条回复——下一轮 mtime 与 size
一起变化，那一行会以完整形态重建。

---

## 4. 解析规则（必须遵守）

### 4.1 一次响应 = 多条 assistant 事件

同一条 `message.id` 会被拆成 2–4 条事件，每条只带一个 content block，
只有最后一条带 `usage`：

```
id=chatcmpl-…  [thinking]        usage=null
               [text]            usage=null
               [tool_use]        usage=null
               [tool_use]        usage=0.034   ← 计费
```

**规则**：按 `message.id` 分组 → 合并 `content[]`（保持文件顺序）→ 从唯一带 usage 的事件取
`credits / original_credits / context_usage_ratio / request_id` → 一个 id 产出一个 turn。

违反此规则的后果：轮次 ×2.18、工具重复计数、正文丢失。

### 4.2 分支

`active-leaf` 的叶子链只覆盖 20% 的事件，且 `isSidechain` 全为 false。
当前语料实际是线性日志，**不做分支重建**；按文件顺序解析 + 按 `message.id` 去重即可。
若未来出现 `isSidechain: true`，先丢弃该事件并在 `source_meta` 计数告警。

### 4.3 工具配对

- `assistant.content[].tool_use {id, name, input}` → 一条 `SrcTool`；
- `user.message.content[].tool_result {tool_use_id, is_error, content}` → 结果；
- 延迟 = 结果时间戳 − 调用时间戳；
- 未配到结果的调用标记 `pending`，不计失败。

### 4.4 提示

`user` 事件中 `content` 为字符串，或数组里 `type: "text"` 的块，视为用户提示；
含 `tool_result` 的 `user` 事件不是提示（可能同时含 text，取 text 部分）。

### 4.5 压缩

压缩是**上下文归零**，所以在 token 空间里判定：相邻两轮的上下文下跌超过 50 000 tok →
生成一条 `compaction` 事件，`tokensBefore = 前一轮上下文`，`tokensAfter = 本轮上下文`。

不能用 ratio 判定，因为分母随模型变（§5.1）：同一个约 166 k 的压缩在 Qwen 上读作 0.92，
在 DeepSeek 上读作 0.83。只有换算到 token 才是可比的。

本机实测（分母按 §5.1 取值）：真实压缩的 `tokensBefore` 中位数 **164 k**，四分之三落在
**150 k – 167 k**（含换模型时的重置，全距 103 k – 167 k）；`tokensAfter` 中位数 **35 k**，
多数在 33 k – 39 k。同模型下最大的非压缩回落是 31 k，被判定为压缩的最小跌幅是 83 k；
换模型时另有 30 k – 50 k 的上下文重算，阈值 50 k 有意不把它们算成压缩——宁可少记一次，
也不误报。

---

## 5. 单位与指标

### 5.1 token = 上下文占用（唯一可还原的口径）

```
context_tokens = round(context_usage_ratio × window)
window = runtime-config.contextWindow            （在模型选择器里钉过窗口时）
       ?? max_input_tokens[模型]                  （否则，这是常态）
```

比例的**分母不是模型选择器显示的那个窗口**。CLI 的构造是：

```js
G4(usage, typeof $e === "number" ? $e : model_config.max_input_tokens)  // ratio = input_tokens / 分母
$e = request.parameters.context_length                                   // 只有钉过窗口才有
if (l?.contextWindow !== void 0 && rS(D, l.contextWindow)) j.context_length = l.contextWindow
```

两个模型的目录行（来自 `qodercli` 的 `current_model_info`）：

| 别名 | 显示名 | `availableContextWindows` | 选择器默认 | `maxInputTokens` | 比例分母 |
|---|---|---:|---:|---:|---:|
| `qfmodel` | Qwen3.8-Flash | 200 K / 400 K / 1 M | 200 000 | **180 000** | 180 000 |
| `dfmodel` | DeepSeek-Flash | 200 K / 400 K / 1 M | 200 000 | **200 000** | 200 000 |

DeepSeek 虽然宣称可用 1 M 窗口，但这台机器上它始终跑在 200 K 模式里，比例的分母就是
200 000。用压缩点可以验证，不需要相信目录：

- Qwen 会话在 ratio 0.82–0.93 处重置，× 180 000 ≈ **148 k – 167 k**；
- DeepSeek 会话在 ratio 0.79–0.83 处重置，× 200 000 ≈ **158 k – 166 k**。

两个模型的压缩都落在 **166 k** 附近同一个绝对预算上。若按 1 000 000 还原，
DeepSeek 的压缩点会变成 790 k – 830 k，已经超出它实际运行的 200 K 窗口，自相矛盾。

另一条佐证：`9da914dd` 同一会话内 `dfmodel` 与 `qfmodel` 交替，两类压缩点交错出现且都
在 0.8 附近——若分母相差 5 倍，还原出的 token 会剧烈跳变。

- 存入 `turns.input`，`output / reasoning / cache_read / cache_write` 全部为 0；
- 于是 `prompt_total = input`、`fill = input / context_window = ratio`，与现有聚合完全兼容；
- **语义是“本轮累积上下文”，不是单次计费输入**，UI 轴标题必须写“context”，不能写“input”。

不估算输出 token（字符数反推会污染所有同比）。

### 5.1a auto 模式：没有 usage 的轮次

模型选到 `auto` 后，assistant 行的 `message` 里**完全没有 `usage`**（无 ratio、无 credits，
只多出 `responseGroupId` / `requestTokenAnchor`）。只读 transcript 会把这些轮次记成
0 token，看起来像“今天什么都没用”。

同一批响应还把**模型名**写成了 `model: "auto"`，但这只是路由占位符，不是用户的
选择：真正的选择在 `runtime-config.model`。本机实测（`2ffe5965`，1.1.86-hotfix.4）
15:10:57Z 起响应行全部是 `auto`，而 `runtime-config` 在 15:11:23Z 写 `ultimate`、
16:20:24Z 又写 `ultimate`（极致），与 `state.json` 的 `credits.byModel.ultimate`
对得上。因此按文件顺序记住最后一条 `runtime-config.model`，用它给 `auto` 行命名；
`auto` 只是占位符，有 `runtime-config` 就必须回到真实选择，不能给它单独开泳道
（客户端真的选了 Auto 时 `runtime-config.model` 就是 `auto`，那是另一回事）。

应用侧的 `.models/default` 在 23:07:42 被改写为 `{"key":"auto","scene":"app"}`，
而 4 分钟后 `runtime-config` 记录的却是 `ultimate`——它只说明 App 当时的默认，
既不是逐轮请求的证据，也不能反过来证明用户选了 auto，命名一律以转录为准。

CLI 自己另有一份计数器：`<project>/<sessionId>/state.json` 的 `s0` 段。它是
AES-256-GCM 加密的（密钥是 CLI 里的常量，AAD = sessionId + cwd 的 SHA-256 + 段名），
解开后是：

```json
{ "latest": {...}, "total": {"input_tokens": …}, "credits": {"total": …, "byModel": {...}} }
```

`s0.total.input_tokens` 与“全量有 ratio 的会话”的 Σ(ratio × window) **逐会话完全相等**，
所以它是缺 usage 轮次的唯一权威来源。解析规则：

- AAD 里的 projectHash 必须按**写端平台**规范化 cwd：Windows 写的是
  `win32.resolve(cwd)` 再转 `/` 且**全小写**（`D:\Download\Code\Kotoba` →
  `d:/download/code/kotoba`）；在 WSL 里用 Linux 的 `path.resolve` 会把 `D:\…` 当相对路径，
  哈希对不上，解密静默失败。Windows 桌面端会话今天为零就是这一条;
- 有 blind（无 usage 且非 `<synthetic>`）轮次时，读 state.json；`Δ = total.input_tokens − Σ 已知 input`；
- Δ 平均分摊到 blind 轮次，单轮不超过该轮的窗口（上下文不可能超过窗口）；
- 超出分摊能力的部分（重试、被压缩掉的旧前缀）**丢弃**，不堆到某一轮上；
- 只对会话主 transcript 做这一步（子 agent 文件共用计数器，会重复计入）。

`credits` 计数器不可用：多数会话为 0，与 transcript 的逐轮 `credits` 不是同一口径，
所以 auto 轮次的成本仍显示 0。token 更正，成本不猜。

### 5.2 积分 = 成本

- `cost` 列存积分（REAL），`credits_micro` 存整数微积分（BIGINT，×1e6）作为精确源；
- 单位由 `meta.unit = "credit"` 声明，API 透出，前端据此切换 `$` → `credit`；
- 不建汇率表、不换算美元（订阅制，`billable` 恒为 false）；
- 展示精度：<1 用 4 位、≥1 用 2 位、聚合可整数。

### 5.3 时间：只有轮次边界

一个响应在 JSONL 里是一条事件行（多行响应才有多行跨度），实测绝大多数 `dur_ms` 为 0–1 ms。
没有"首个 token → 写完"的流式时间戳，所以首字延迟与 decode 速度都无法准确计算，
应用里不做估算，也不展示这两个指标。

### 5.4 模型名映射

| 别名 | 真实名 |
|---|---|
| `qfmodel` | `Qwen3.8-Flash` |
| `dfmodel` | `DeepSeek-Flash` |
| `<synthetic>` | 本地提示（非模型输出）：0 usage，按 system 消息入库，不参与模型命名 |

规则：

1. 会话内 `alias` 与 `real` 一一对应 → 使用真实名；
2. 会话内出现多个别名或冲突证据 → 回退显示别名（`dfmodel + qfmodel`）；
3. 无遥测证据 → 若别名在全局映射中且已被至少一个无歧义会话验证，使用真实名；
4. `<synthetic>` 与空模型名**不是模型**，不参与命名（否则 `bb1e6e1d` 会显示成
   `<synthetic> + qfmodel`，把压缩提示当成一个模型）；
5. 映射证据（会话、次数、是否冲突）写入 `sourceMeta`，别称变更可被发现；
6. `auto` 是占位符：1.1.86 起响应行用它覆盖用户选择，命名必须回到 `runtime-config.model`
   （§5.1a）；有配置却仍落在 `auto` 泳道，就是把占位符当成了模型。

### 5.5 项目泳道

`inferProject` 从工具触达的路径投票决定项目泳道。Qoder 会把自己的状态目录
（`.qoder/projects/<encoded>/memory/*`、`.qoder/tmp/<encoded>/tool-outputs/*`）
写进工具入参，而 `<encoded>` 形如 `-home-kitsunemori`：一旦参与投票，从家目录
启动的会话就会被标成 `-home-kitsunemori`。因此**`.qoder` / `.opencode` / `.osm`
下的路径不参与泳道推断**，只保留真实的项目文件。

---

## 6. 归一化映射

| OSM | Qoder | 说明 |
|---|---|---|
| `session.id` | 文件名（UUID） | |
| `session.title` | `ai-title.aiTitle` → `last-prompt` 首行 | |
| `session.directory` | `cwd` / `workspace-directories[0]` | |
| `session.created/updated` | 首/末事件时间 | |
| `turn.id` | `message.id` | 合并键 |
| `turn.model` | `message.model` → 映射 | |
| `turn.created` | 事件 `timestamp` | |
| `turn.finish` | `message.stop_reason` | |
| `turn.parts` | `thinking` / `text` / `tool_use` | 顺序保持 |
| `tool.status` | `tool_result.is_error` → error / completed | |
| `tool.started/ended` | tool_use / tool_result 时间戳 | |
| `tool.additions/deletions` | Edit 的 `new_string` / `old_string` 行数 | 近似 |
| `tool.writeLines` | Write 的 `content` 行数 | |
| `event.compaction` | ratio 回落 | |

---

## 7. 接口与配置

```ts
// source-select.ts
interface SourceLike {
  readonly kind: "opencode" | "qoder";
  readonly path: string;
  readonly unit: "usd" | "credit";
  readonly schema: string;
  sessions(): SrcSession[];
  turns(ids?: Set<string>): SrcTurn[];
  events(ids?: Set<string>): SrcEvent[];
  patchFileCounts(ids?: Set<string>): Map<string, { files: number; paths: string[] }>;
  maxMessageTime(): number;
  changedSessions(since: number): Set<string>;
  close(): void;
}
```

选择顺序（决定的是**默认源**，页眉可随时切另一份）：

1. `OSM_SOURCE=opencode|qoder`
2. `OSM_SOURCE_DB` 显式给出 → `opencode`
3. 自动：`~/.local/share/opencode/opencode.db` 存在 → opencode；否则 `~/.qoder/projects` 存在 → qoder

两库并存与切换的完整设计见 [source-scope.md](./source-scope.md)。

Qoder 根目录：`OSM_QODER_HOME`（默认 `~/.qoder`）。转录树的完整清单是
`QODER_PROJECT_ROOTS`——默认 `~/.qoder/projects` 加上 WSL 下每个 Windows 配置文件
（`/mnt/<盘>/Users/<name>` 或搬家后的 `/mnt/<盘>/<name>`）里的 `.qoder/projects`，
只在该目录真的含转录时才收；`OSM_QODER_PROJECT_ROOTS`（逗号分隔）整体覆盖。
`/api/sources` 的 `roots` 报出除主树以外还读了哪些。

增量：`maxMessageTime()` = 会话文件最大 mtime；`changedSessions(since)` = mtime > since 的会话。
不维护偏移文件，避免与 Qoder 自己的写入竞争。

---

## 8. Schema 变更

```sql
ALTER TABLE turns    ADD COLUMN credits_micro INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN credits_micro INTEGER DEFAULT 0;
```

- `SCHEMA_SIG` 变化 → 旧 store 自动全量重建（既有机制）；
- `meta.unit` 记录本库的成本单位；
- `flow` / `heat` 继续用 `cost` 聚合（同一单位），不新增列。

---

## 9. 验收门

1. 会话数 = 24，`count(distinct message.id) = 6 204`，其中 assistant 6 183、system 21、user 489，无重复 turn id；
2. `sum(credits_micro) / 1e6 = 689.965 ± 0.01`；
3. 工具调用 = 6 765，失败 = 316（4.7%）；
4. 压缩事件 = 43（上下文回落 > 50 000 tok）；
5. 每轮 `input == round(ratio × window)`，`window` 按该轮模型取（钉过窗口则取钉的值），`fill == ratio ± 1e-6`；
6. 混合会话（`4a8b72e7`）必须回退别名，不得输出单一真实名；
7. 子代理转录并入父会话：8 个文件不产生第 25 个会话，积分 +8.708；
8. 项目泳道里不得出现 `-home-kitsunemori` 这类编码目录名；
9. 模型面板不得出现 `<synthetic>`；
10. 增量构建：改一个会话文件后只重建该会话；
11. 多个转录根并读：Windows 侧会话进同一个源，项目泳道取 `workspace-directories`
    的反解名（`qoder通用工作区`），不是编码目录名（`D--Download-Code-qoder-----`）；
12. 一个会话 id 出现在两棵树时只计一次，且取的是更完整的那一棵（副本不是两半）；
13. Windows 会话的盘符路径要计入改动文件（`files_changed > 0`），不能因为
    `D:\…` 不像 POSIX 路径就被丢掉；
14. 1.1.86-hotfix.4 的 `auto` 行必须按最后一条 `runtime-config.model` 命名；本机实测
    `2ffe5965` 的 `auto` 段落应落在 `qmodel_38max` / `ultimate` / `dfmodel`，面板里
    不再有一条名为 `auto` 的泳道。

---

## 10. 非目标

- 不解析 Qoder 的 IDE SQLite（`local.db` / `atlas.db`）。`local.db` 仅存 2026-05 前的
  17 个原生会话：正文加密、没有积分、模型只记 `auto`，并入积分库会让 tokens/credit 与
  成本失真；Windows 侧当前 worker 会话也没有落本地转录。也不另存快照兜底：宁可将来
  重新讨论是否接入，也不让一份来路不明的旧库先混进证据链。
- 不估算输出 token、不伪造输入/输出拆分；
- 不读 `~/.qoder/session-migration-backup-*`：那是 Qoder 自己在树之间搬家时留的旧
  `main.sqlite` 副本，同一条会话已经活在新根里，读它只会制造双计；
- 不做逐请求模型名归因（证据不同框）；
- 不引入汇率与美元成本。

---

## 11. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 无官方 schema，字段随版本漂移 | 高 | 必需字段断言；缺失降级为只读告警，不崩溃 |
| 模型别名轮换 | 中 | 会话级校验 + 冲突回退 + 证据入库 |
| `contextWindow` 多为 `null` | 低 | 分母用模型目录的 `max_input_tokens`（§5.1），未知模型才回落 200 000 |
| transcript 含完整代码与提示 | 低 | 全程本地处理，沿用 OSM 的 loopback 绑定 |
| 大文件解析开销 | 低 | 增量按 mtime；全量 65 MB 约 2–3 s |

---

## 12. 工作量

| 项 | 人日 |
|---|---|
| QoderSource（解析、合并、配对、事件） | 2.0 |
| 数据源选择 + config + 增量水位 | 0.5 |
| 积分字段与聚合 | 0.5 |
| 模型映射与会话级校验 | 0.4 |
| 单元/集成测试（合成 fixture） | 0.8 |
| UI 单位切换（$ → credit） | 0.5 |
| 文档与验收 | 0.3 |
| **合计** | **≈5.0** |
