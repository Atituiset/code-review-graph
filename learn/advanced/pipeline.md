# 解析与存储：tree-sitter、SQLite 图模型、增量更新

本章拆开管线的核心两段：如何把源码抽成图（解析），以及图如何落盘并低成本保鲜（存储与增量更新）。

## tree-sitter 抽取模型

### 四张映射表决定"抽什么"

code-review-graph 不为每种语言写独立的语法分析逻辑，而是把 tree-sitter 的节点类型名归纳成四张声明式映射表（`code_review_graph/parser.py`）：

| 表 | 位置 | 作用 |
|---|---|---|
| `_CLASS_TYPES` | parser.py:898 | 哪些 AST 节点映射为 `Class`/`Type` 节点 |
| `_FUNCTION_TYPES` | parser.py:996 | 哪些节点映射为 `Function`/`Test` 节点 |
| `_IMPORT_TYPES` | parser.py:1071 | 哪些节点产生 `IMPORTS_FROM` 边 |
| `_CALL_TYPES` | parser.py:1127 | 哪些节点产生 `CALLS` 边 |

每种语言在这四张表里登记自己的 tree-sitter 节点类型名（如 Python 的 `function_definition`、Go 的 `function_declaration`/`method_declaration`）。AST 遍历是语言无关的：按语言查表，命中即抽取成 `NodeInfo`/`EdgeInfo`。新增一门 tree-sitter 语言的成本因此主要是**填四行表**，而不是写一套遍历逻辑——这是项目能覆盖几十种语言的结构性原因。

### 语言覆盖面：三层实现

1. **tree-sitter 主力层**：`EXTENSION_TO_LANGUAGE`（parser.py:713）登记约 40 种语言，从主流（python/typescript/go/rust/java/cpp/csharp/php/ruby/kotlin/swift……）到长尾（gdscript/verilog/solidity/luau/nix/zig……）。grammar 统一来自 `tree_sitter_language_pack`，避免逐语言维护绑定。
2. **regex 兜底层**：没有可用 grammar 的语言用正则实现结构化抽取——VB.NET（parser.py:1325）和 ReScript（parser.py:1572：注释剥离 + 行锚定正则 + 花括号计数的模块扫描，刻意避免被字符串字面量里的"代码"骗到，见 parser.py:3971 的注释）。SQL 的 `CREATE PROCEDURE` 与表抽取也有 regex 兜底分支（parser.py:2667、3327）。
3. **伪语言特判层**：`.vue`/`.svelte`/`.ipynb` 这类文件不是单语言，走专用路径（parser.py:2630-2655）：Vue SFC 先用 vue parser 再把 script 块委托给 JS/TS；notebook 抽出 code cell 按 Python 解析；连 Databricks 的 `.py` notebook 导出（首行恒为 `# Databricks notebook source`）都有特判。

三层共享同一套 `NodeInfo`/`EdgeInfo` 产物格式，下游完全感知不到某个符号是 tree-sitter 抽的还是正则扫的。

语言判定本身也有层次：先看扩展名；无扩展名或扩展名不明的文件读取头部最多 256 字节探测 shebang（parser.py:844-845 的注释解释了 256 的选取——足够容纳 `#!/usr/bin/env python3 -u` 这类长行）。因为 `parse_bytes` 从同一份字节做判定，shebang 探测不会引入额外的磁盘读取。

### 声明式扩展：custom_languages.py

仓库内放一份 `.code-review-graph/languages.toml`（路径常量见 `custom_languages.py:48`），即可声明新语言：扩展名映射、注释语法、regex 抽取规则。加载时做校验（`custom_languages.py:116`）。这让领域语言/内部 DSL 不需要改主包就能入图——本质上是把 regex 兜底层做成了用户自助的声明式接口。

### 防 native crash：子进程探活

tree-sitter grammar 是 native 代码，一个有 bug 的 grammar 会以 segfault 杀死**整个宿主进程**——这不是异常，catch 不住。对策是在主进程加载任何 grammar 之前，先派生一个一次性子进程试加载（`_run_parser_load_probe`，parser.py:473），带超时控制；探活失败就把该语言拉黑跳过，而不是让整个构建陪葬。这是"第三方 native 依赖不可信"假设下的标准工程防御，代价是每语言一次进程启动的固定开销。

### 伪语言与特殊文件一览

| 扩展名 | 伪语言 | 处理路径 |
|---|---|---|
| `.vue` | vue | vue parser 解析 SFC，script 块委托 JS/TS |
| `.svelte` | svelte | 同构于 vue 的委托策略 |
| `.ipynb` | notebook | 抽取 code cell，按 Python 解析 |
| `.py`（首行 `# Databricks notebook source`） | databricks notebook | 专用导出格式特判（parser.py:2654） |
| `.sql` | sql | grammar 为主，`CREATE PROCEDURE`/表抽取走 regex 兜底 |

这些分支的意义不在于支持了冷门格式，而在于保证"一种扩展名一种解析策略"的假设被打破时，管线其余部分（哈希、入库、后处理）完全无感。

## SQLite 图模型

schema 主定义在 `graph.py:74-121`，当前版本 **v9**。版本演进由 `migrations.py` 管理：版本号存于 `metadata` 表，每个迁移（`_migrate_v2` 到 `_migrate_v9`）在独立事务中执行（migrations.py:262-274），老数据库打开时自动逐级升级。

### nodes 表

每行一个符号节点（`File`/`Class`/`Function`/`Type`/`Test`），关键列：

- `qualified_name TEXT UNIQUE`：全局唯一键（如 `module.Class.method`），是边引用节点的凭据；
- `file_hash TEXT`：该文件内容的 SHA-256，增量短路用；
- `line_start`/`line_end`：变更行区间映射（第 4 章）和源码 ±2 行裁剪（第 5 章）都依赖它；
- `params`/`return_type`：签名计算与展示的原料；
- `extra TEXT DEFAULT '{}'`：开放 JSON 列，承载语言特定证据（装饰器、verilog_kind、resolver 线索……），避免为每个语言的特性加列。

### edges 表：字符串名而不是外键

边以 `source_qualified`/`target_qualified` **字符串**引用节点，而非整数外键。这是全 schema 最重要的取舍：

- **优点**：允许指向尚不存在的节点。解析文件 A 时它调用的 `helper()` 可能在尚未解析的文件 B 里，也可能在外部库里——裸名先入库，全局解析留给后处理。这正是单文件原子替换（第 1 章）能成立的前提：插入不需要先检查引用目标的 id。
- **代价**：没有引用完整性约束。指向已删除节点的"幽灵边"（dangling edge）可能残留；查询侧必须容忍 target 不在 nodes 表里的边（事实上 flow 追踪还把这类"图外目标"当作外部调用信号来用，见第 4 章 criticality 的外部调用因子）。

v9（`_migrate_v9`）为边增加 `confidence REAL DEFAULT 1.0` 与 `confidence_tier TEXT DEFAULT 'EXTRACTED'`：区分 tree-sitter 直接抽出的证据边（EXTRACTED）和 Resolver 启发式推断的边（INFERRED，见第 3 章），让下游可以按可信度过滤或降权。

### 派生层

- **FTS5 虚表** `nodes_fts`：BM25 全文检索，由 `search.py` 的 `rebuild_fts_index` 维护。v5 迁移（migrations.py:147-158）给出了它的精确定义：索引列为 `name, qualified_name, file_path, signature`，`content='nodes'` 外接内容表模式（不复制文本，省一倍存储），分词器 `porter unicode61`——unicode61 负责多语言标识符切分，porter 词干器让英文搜索容忍单复数/时态差异；
- **flows / flow_memberships / communities 表**：离线预计算的执行流与社区划分（第 4 章）；
- **v6 三张预计算摘要表**：`community_summaries`、`flow_snapshots`、`risk_index`（`migrations.py:163-203`，含 `idx_risk_index_score` 降序索引）——把常用查询结果物化，查询期只做主键反查而不展开子图。这是 token 经济（第 5 章）的存储基础。

## 增量更新：三条路径，一个合并点

全量重建对日常编辑太贵。增量更新目标是"只动变化的部分及其受影响邻居"。三条触发路径最终汇入同一套调和逻辑：

### 路径 1：git diff 基点

`metadata` 表记录上次构建时的 `git_head_sha`。`resolve_incremental_base`（`incremental.py:644`）以它为基点跑 diff，一次调和自上次同步以来的**全部**变化——而不是 `HEAD~1` 那种只看最后一个 commit 的朴素做法。其 docstring 明确指出后者的缺陷：固定基点会静默漏掉中间提交。

### 路径 2：watchdog 监听

watch 模式下，文件系统事件经 1 秒防抖批处理（`_DEBOUNCE_SECONDS = 1`，`incremental.py:1362`；基于 `watchdog.utils.event_debouncer.EventDebouncer`），把编辑器"连续保存 N 次"折叠成一次更新。防抖而非逐事件处理，避免保存风暴把解析队列打爆。防抖器只负责合并事件并触发回调（incremental.py:1514-1529），自身不持有图的状态——状态全部在 SQLite，watch 进程重启后从 `git_head_sha` 基点自然续上。

### 路径 3：SHA-256 短路

无论哪条路径，候选文件先比 `file_hash`：内容哈希未变直接跳过解析。这让"增量更新"在无实际变化时趋近一次 O（文件数） 的哈希扫描，而非全量 tree-sitter 解析。三条路径的关系是：git diff 和 watchdog 决定**候选集**，哈希短路决定候选集里**真正要解析的子集**。

### 依赖扇出与对账

- **反向依赖重解析**：变更文件之外，`find_dependents`（`incremental.py:985`）沿依赖边反向扩最多 2 跳（`_MAX_DEPENDENT_HOPS`，incremental.py:944，可用 `CRG_DEPENDENT_HOPS` 调整）、总文件数 500 封顶（`_MAX_DEPENDENT_FILES`，incremental.py:945，超限截断并记录），把这些依赖者也重解析——因为被依赖者的签名/结构变化会改变依赖者边上的解析结果。
- **删除对账**：`_reconcile_stale_files`（`incremental.py:908`）比对 nodes 表记录的文件集与磁盘实际文件清单，清理已消失文件的全部数据。对账结果还会喂给 Resolver 触发条件（见 `incremental.py:1324-1327` 的注释）：一个"只删除了文件"的变更必须照样触发相关 resolver 清理派生态，否则已删 listener 会留下幽灵虚拟边（issue #474）。

## 解析产物：NodeInfo / EdgeInfo
`NodeInfo`（parser.py:668）与 `EdgeInfo`（parser.py:692）是解析层与存储层之间的契约，均为纯 dataclass，不含任何 I/O 句柄——这是进程池 worker 能直接 pickle 返回结果的原因。

`NodeInfo` 的 `__post_init__` 里有一条值得注意的身份不变量（issue #774）：所有文件路径统一规整为 POSIX 分隔符，File 节点的 `name` 也承载路径。效果是 Windows 与 Linux 上解析出的图在 qualified name 层面保持一致——跨平台协作、CI 与本地混用同一仓库时不会产生两套键。

## 工程亮点与已知局限

**亮点**：进程池解析无锁化；单文件原子替换保证幂等；字节级 `parse_bytes` 消除 TOCTOU；四张声明式映射表把语言支持成本降到填表级别；native grammar 子进程探活隔离崩溃域。

**局限**（如实记录）：

- `parser.py` 是一个 **16080 行的上帝文件**：所有语言的特判、regex 兜底、伪语言分支都堆在里面，是全项目最大的可维护性负担；
- 2 跳/500 文件的截断意味着深层间接依赖可能漏更新，图会短暂陈旧，需等下次相关变更或全量构建自愈；
- 字符串边无引用完整性，幽灵边客观存在，正确性靠查询侧容错而非存储侧约束兜底；
- FTS 索引是整体重建（`rebuild_fts_index` 名实相符），超大仓库上每次更新都全量重建索引的成本不可忽略——它没有做增量索引维护。

## 附：schema 版本演进一览

`migrations.py` 的 v2–v9 迁移本身就是一部项目演化史（每个迁移的 docstring 注明了动机）：

| 版本 | 内容 | 服务的功能 |
|---|---|---|
| v2 | nodes 加 `signature` 列 | 人类可读签名，token 友好的符号展示 |
| v3 | 建 `flows` / `flow_memberships` | 执行流物化（含 `idx_flows_criticality` 降序索引） |
| v4 | 建 `communities`，nodes 加 `community_id` | Leiden 社区 |
| v5 | 建 `nodes_fts` FTS5 虚表 | BM25 全文检索（`porter unicode61` 分词，content 指向 nodes 表） |
| v6 | 建三张预计算摘要表 | token 经济（第 5 章） |
| v7 | 边表加 `(target_qualified, kind)` / `(source_qualified, kind)` 复合索引 | 摘要与风险查询提速 |
| v8 | 边表加五列复合索引 | `upsert_edge` 性能 |
| v9 | 边表加 `confidence` / `confidence_tier` | 区分 EXTRACTED / INFERRED（第 3 章） |

两个观察：其一，v5 之后所有迁移都是**索引与派生表**——主模型（nodes/edges 字符串键）从早期就稳定了；其二，性能优化的方向始终是查询期（索引）和预计算（摘要表），没有一次是给写入路径加复杂度。

## 附：增量更新的决策顺序

把三条路径和扇出规则串起来，一次增量更新的完整决策顺序是：

1. 确定候选文件集：git diff（相对 `git_head_sha`）或 watchdog 防抖批次；
2. 哈希短路：候选中 `file_hash` 未变的剔除；
3. 反向扇出：`find_dependents` 扩 2 跳、500 文件封顶，并入待解析集；
4. 进程池并行解析待解析集；
5. 逐文件 `store_file_nodes_edges` 原子替换；
6. `_reconcile_stale_files` 对账删除的文件；
7. 按变更语言条件触发对应 Resolver（含 stale 文件触发的清理）；
8. `run_post_processing` 刷新派生表；
9. 更新 `metadata.git_head_sha` 为当前 HEAD，为下一次增量定基点。

第 9 步常被忽略但很关键：基点前移让下一次 diff 只覆盖"上次同步之后"的区间，增量更新因此是自校正（self-correcting）的——只要某次更新成功完成，之前任何遗漏都被这次的全区间 diff 覆盖。

## 小结

解析层的核心取舍是"声明式映射 + 分层兜底"，让 40 种语言共享一条管线；存储层的核心取舍是"字符串键 + 单文件原子替换"，用引用完整性换幂等性和延迟解析的自由；增量层的核心取舍是"候选集（diff/watch）与必要性判定（哈希）分离"，再辅以有界的依赖扇出。三者共同支撑起第 1 章那条看似简单的四阶段管线。
