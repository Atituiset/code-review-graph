# 与 mcp-language-server 的对比（LSP 代理路线）

> 本章对比的对象是一个独立项目 [mcp-language-server](https://github.com/isaacphi/mcp-language-server)（本章以其深度定制 fork 为准，Go 实现，约 9,500 行手写代码）。文中 `internal/...`、`main.go`、`tools.go` 等路径引用的是该项目；`code_review_graph/...` 路径引用的是本项目。

如果说[与 clangd / CSA 的对比](./vs-clangd-csa.md)讨论的是"三个不同物种"，本章讨论的是**同一个生态位里的两条相反技术路线**：mcp-language-server 和 code-review-graph 都是"给 AI agent 喂代码上下文的 MCP server"，但一个选择**代理真实 LSP 的编译级语义**，一个选择**自建 tree-sitter 持久图谱**。

## 一句话定位

- **mcp-language-server**：把真实 LSP server（clangd / gopls / rust-analyzer / pyright …）的编译级语义代理给 LLM，重在**精确导航与编辑**。
- **code-review-graph**：用 tree-sitter 自建持久知识图谱（SQLite），重在**审查影响面分析与 token 经济的架构概览**。

## 总览表

| 维度 | mcp-language-server | code-review-graph |
|---|---|---|
| 语义来源 | 外部 LSP server 的真索引（类型、重载决议、宏展开全准） | tree-sitter 单文件抽取 + 命名唯一性启发式 resolver |
| 状态模型 | 无持久索引，索引活在 LSP 进程内存里 | SQLite 持久图 `<repo>/.code-review-graph/graph.db` |
| 计算时机 | 查询时实时问 LSP（加 TTL 缓存兜底） | 构建时预计算物化，查询期 SQL 反查 |
| 消费形态 | 单次问答：definition / references / hover / diagnostics | 预计算切片：impact radius / flows / communities / 风险评分 |
| 上下文预算 | 字节预算（8KB payload、50 行/4KB 每层） | token 预算（摘要表、detail_level、变更节点 ±2 行裁剪） |
| 写能力 | `edit_file` / `rename_symbol`（默认关闭，需显式开启） | 只读分析（refactor 只做规划） |
| 语言覆盖 | LSP 支持谁就支持谁；自带 tree-sitter 层仅 C/C++ | 零配置约 40 种语言，但每种语言深度浅 |
| 并发模型 | 每 workspace 一个 LSP 进程；daemon + proxy 多客户端共享；信号量限 3 并发 | 每个 MCP 客户端直开 SQLite（WAL 并发读）；daemon 只管 watch |
| 冷启动 | 千万行 C++ 上 clangd 建索引 30–60 分钟、RSS 2–6GB | 全量建图几十秒到几分钟，之后永久复用 |

## 五个本质差异

### 1. 精度与可达性的取舍正好颠倒

mcp-language-server 的答案**一定是对的**——`callers`/`callees`（tools.go:651/:722）来自 clangd 真实的调用层级，类型、重载、宏展开全部精确。但前提是 LSP 索引建得起来：项目自己的基线文档记录，千万行 C++ 代码库上 clangd 首次索引需要 30–60 分钟、常驻内存 2–6GB，而且要求 `compile_commands.json` 可用。

code-review-graph 的 callers 是启发式猜的（唯一候选才收编，重名静默失效，见[语义解析层](../advanced/resolvers.md)），但任何语言、编译不过的遗留代码、没有编译数据库的环境，几十秒就能出结果。

这是同一个权衡的两端：**用可达性换精度，或用精度换可达性**。

### 2. 查询时计算 vs 构建时预计算

mcp-language-server 每次工具调用都实时向 LSP server 发 JSON-RPC 请求（`internal/lsp/client.go:79-130`），用一个带文件依赖反向索引的 TTL 缓存（默认 300 秒）兜底。答案永远新鲜，但每次都要付 LSP 的响应延迟。

code-review-graph 把 flows、communities、`risk_index` 等在建图时全部物化到 SQLite（见[查询引擎](../advanced/query-engine.md)），查询期只是 SQL 反查。响应快、token 省，但有 stale 风险——靠 git diff 基点 + 内容 hash 的增量更新续命。

### 3. token 控制的粒度不同

mcp-language-server 按**字节**裁剪：统一搜索总预算 8KB payload（router.go:528-531），显式单层策略每层 50 行/4KB，截断时附"如何缩小范围"的提示。简单、可靠、可预测，但不知道裁掉的那一段是不是最重要的。

code-review-graph 按**语义**裁剪：预计算摘要表、`detail_level=minimal`、约 100 token 的 `get_minimal_context` 入口、只抽变更节点前后约 2 行（见[Token 经济](../advanced/token-economy.md)）。更聪明，但裁剪质量依赖启发式的好坏。

有趣的是两者量级其实接近：8KB ≈ 2K token，mcp-language-server 的单层预算比 code-review-graph 大多数响应还要紧凑。

### 4. 能力清单互有空白

mcp-language-server 有、而 code-review-graph 完全没有的：

- `diagnostics`——真实编译诊断（LSP 直通，还附带交互式 HTML UI）
- `hover`——真实类型信息
- **编辑工具**——`edit_file` / `rename_symbol`（默认关闭，显式 opt-in）
- **四层统一搜索**——ripgrep / tree-sitter / ast-grep / LSP 的结果归一化为 CodeAtom IR（router.go:543-672），merge/dedup 后按预算裁剪。这比 code-review-graph 的"FTS5 + 可选向量"双轨搜索更成体系。

code-review-graph 有、而 LSP 体系里没有对应物的：

- **影响半径**——边权 × 深度衰减的图扩散（`get_impact_radius_sql`）
- **执行流与 criticality**——入口点到叶子的可达路径及其权重
- **Leiden 社区**——自动发现的架构中间层
- **风险评分与 test_gaps**——纯"审查"视角的分析维度

这份差异清单本身就是两个项目定位的最好注脚：一个围绕"**改代码**"，一个围绕"**审代码**"。

### 5. 进程与共享模型

mcp-language-server 的 daemon + proxy 设计解决的是"LSP 进程太贵，多客户端要共享"：daemon 在 loopback 上跑 streamable HTTP，proxy 通过 session 文件发现并复用，30 分钟无会话自动退出。索引是稀缺资源，所以架构围绕**复用索引**展开。

code-review-graph 的索引（SQLite 文件）天生可复制、可并发读（WAL），daemon 退化成一个只管 watch 保活的编排器，无 IPC、只有活/死二元健康检查。索引不稀缺，所以架构围绕**保持索引新鲜**展开。

进程模型的差异直接来自状态模型的差异。

## 互补关系

两者是同一个 agent 工具箱里的互补件，不是竞品：

- 改代码、找定义、看诊断 → **mcp-language-server**（精确）
- 审 PR、评估爆炸半径、看架构、找测试缺口 → **code-review-graph**（全局）

一个理想的 agent 工作流是串联使用：先用 code-review-graph 的 `detect_changes` 圈出高风险改动和影响面，再用 mcp-language-server 对具体符号做精确定位、查看诊断、执行编辑。

## 互相可借鉴什么

**code-review-graph 值得借鉴的**：

- 持久化 SQLite 图——这是 clangd 冷启动痛点的另一种解法。基于 LSP 的工具如果要服务超大型代码库，落一个持久索引层（哪怕只是调用层级缓存）能根本改变冷启动体验。
- 预计算摘要表——把 token 敏感场景的答案在构建期算好。

**mcp-language-server 值得借鉴的**：

- CodeAtom 四层搜索归一化 IR——code-review-graph 的 FTS5/向量双轨搜索还没有这种统一抽象。
- daemon + proxy 的进程复用与会话发现机制——code-review-graph 的 daemon 无 IPC，相比之下相当简陋。
- 编辑类工具默认关闭、显式 opt-in 的安全姿态。

## 小结

| | mcp-language-server | code-review-graph |
|---|---|---|
| 哲学 | 语义必须正确，贵一点没关系 | 覆盖必须够广，精度可以启发式 |
| 最佳状态 | 有编译环境的中大型 C/C++/Go/Rust 项目 | 多语言、无编译环境、审查驱动的工作流 |
| 最怕的场景 | 建不起索引的巨型遗留库 | 大型多模块同名符号满天飞的库 |

把[与 clangd / CSA 的对比](./vs-clangd-csa.md)里的坐标系拿来：mcp-language-server 站在 clangd 一侧（编译级精度），code-review-graph 站在 tree-sitter 一侧（广度与速度）——本章就是那条光谱上两个具体落点的对照。
