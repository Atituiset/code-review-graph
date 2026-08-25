# 架构总览：四阶段管线

code-review-graph 的整体架构可以压缩成一句话：**一条单向的数据管线，把文件系统变成 SQLite 里的符号关系图，再由多个入口以只读方式查询**。理解这条管线，就理解了整个项目；其余部分（MCP 服务、daemon、hook、技能文档）都是挂在管线两端的适配器。

## 四阶段数据流

```
文件系统 (git 仓库)
      │
      ▼
┌─────────────┐   git ls-files + ignore 规则
│ 1. 发现      │   collect_all_files  (incremental.py:1027)
└─────────────┘
      │  文件清单 + 字节内容
      ▼
┌─────────────┐   tree-sitter 进程池并行
│ 2. 解析      │   CodeParser.parse_bytes  (parser.py:2600)
└─────────────┘
      │  NodeInfo / EdgeInfo（含未解析裸名）
      ▼
┌─────────────┐   BEGIN IMMEDIATE，单文件原子替换
│ 3. 入库      │   GraphStore.store_file_nodes_edges  (graph.py:359)
└─────────────┘
      │  nodes / edges 主表就绪
      ▼
┌─────────────┐   裸端点解析 → 签名 → FTS5 → flow → Leiden 社区
│ 4. 后处理    │   run_post_processing  (postprocessing.py:31)
└─────────────┘
      │
      ▼
  派生表（flows / communities / 摘要表）就绪，进入可查询状态
```

管线是严格单向的：下游阶段只消费上游产物，没有回写。这个约束让每一阶段可以独立推理和测试——解析不需要知道 SQLite 存在，入库不需要知道 tree-sitter 存在。

## 阶段 1：发现

`collect_all_files`（`code_review_graph/incremental.py:1027`）枚举仓库内所有可解析文件。首选路径是 `git ls-files`，它天然跳过 `.gitignore` 覆盖的内容和未跟踪文件；函数还接受 `recurse_submodules` 参数控制是否进入子模块。非 git 场景（或其本身失败时）退化为文件系统遍历，再套用项目自己的 ignore 规则。

发现阶段只产出路径清单，不读内容——读内容推迟到解析阶段，配合 SHA-256 哈希短路（见下一章），让"哪些文件需要解析"的判定尽量廉价。

## 阶段 2：解析

`CodeParser.parse_bytes`（`code_review_graph/parser.py:2600`）接收预先读好的字节而不是路径。签名里的这个选择是一个刻意的 TOCTOU 防护：哈希计算、shebang 语言探测、tree-sitter 解析全部作用于**同一份字节**，入库的 `file_hash` 永远描述实际被解析的内容——不会出现"哈希的是 A 版本、解析的是 B 版本"的竞态。

产物是两个纯数据列表：

- `NodeInfo`（parser.py:670）：kind/name/file_path/line 区间/params/return_type/is_test/extra 等；
- `EdgeInfo`（parser.py:694）：kind（CALLS/IMPORTS_FROM/INHERITS/IMPLEMENTS/CONTAINS……）加 source/target 字符串名。

并行化发生在调用侧：`_make_executor`（incremental.py:70）按 `_select_executor_kind`（incremental.py:43）的选择工作，默认 `ProcessPoolExecutor`——worker 不能继承父进程的 SQLite 连接或 MCP transport，所以必须是进程而非线程；MCP stdio 服务活跃或 Windows 非 TTY 时退化为 `ThreadPoolExecutor`，避免 fork 破坏 stdio 流。worker 数上限是 `min(CPU 核数, 8)`。每个 worker 只返回上述纯数据，不带任何 SQLite 句柄，因此解析阶段完全无锁、无事务、无共享状态。

**关键设计：解析阶段故意不做全局名称解析。** 跨文件引用以裸字符串名（如 `handle`、`UserService::save`）原样写入边，证据（receiver、import 来源等）塞进边的 `extra` JSON。全局解析推迟到阶段 4 和 Resolver 层（见第 4 章）。这个"延迟解析"决定是进程池能成立的前提——单文件解析若需要全图上下文，并行 worker 之间就需要共享数据库，整套简洁性立刻崩塌。

## 阶段 3：入库

`GraphStore.store_file_nodes_edges`（`code_review_graph/graph.py:359`）以**单文件为原子单位**做替换式写入：

1. `_begin_immediate()`（graph.py:354）执行 `BEGIN IMMEDIATE`——立刻拿到写锁，避免 deferred 事务在中途升级时的锁竞争与死锁窗口；
2. `remove_file_data(file_path)` 删除该文件旧的全部节点和边；
3. 插入新的节点、边和 `file_hash`；
4. 提交。

"删光再插"而不是 diff 合并，代价是重写量略大，换来的是**幂等性**：同一个文件解析两遍，结果严格一致，不存在部分更新的中间态。崩溃恢复也因此简单——事务要么完整落地，要么整体回滚，文件粒度上永远不会半旧半新。对增量更新场景（一个文件的变更可能触发多次重解析）而言，幂等性比重写成本值钱得多。

## 阶段 4：后处理

`run_post_processing`（`code_review_graph/postprocessing.py:31`）在主表就绪后顺序填充派生数据，固定五步（其模块 docstring 逐条列出）：

| 序 | 步骤 | 函数 | 干什么 |
|---|---|---|---|
| 1 | 裸端点解析 | `_resolve_bare_endpoints` (postprocessing.py:73) | 把裸名调用目标按全图唯一匹配补全为 qualified name，兼处理 C++ 作用域目标和裸 TESTED_BY 源端 |
| 2 | 签名计算 | `_compute_signatures` | 为缺签名的节点生成 `def f(params) -> ret` 风格签名（上限 512 字符） |
| 3 | FTS5 重建 | `_rebuild_fts_index` | 刷新全文检索虚表 |
| 4 | flow 追踪 | `_trace_flows` | 从入口点前向遍历调用图，物化执行流 |
| 5 | 社区检测 | `_detect_communities` | Leiden 算法（或目录分组兜底）切分模块社区 |

顺序有讲究：裸端点解析必须在 flow/社区之前（后两者依赖补全后的 CALLS 边）；FTS 在签名之后（索引要包含签名文本）。

每一步都被 try/except 包裹、**非致命**：失败只记入返回 dict 的 `warnings` 列表，主构建结果不丢。这是一个明确的取舍——派生数据全部可以从主表重建，所以主表的正确性优先级严格高于派生数据的完整性；宁可搜索暂时不可用，也不能让一次构建整体失败。

另有一个默认关闭的第六步：显式传入 provider 和 model 时刷新 embeddings（`_refresh_embeddings`，postprocessing.py:175）。默认关闭的理由写在 docstring 里：云端 provider 会把源码派生文本传出本机并产生 API 成本。

后处理还有**档位**：MCP 的 build 工具（`tools/build.py`）在上述步骤之外补建 v6 三张摘要表，并按 `postprocess` 参数分档——`full`（默认，全部）、`minimal`（签名+FTS 为止，跳过 flow 与社区）、`none`；CLI 的 `--skip-flows` / `--skip-postprocess` 是同一开关的人面。每档都记录各阶段的耗时（`postprocess_timing`），让"构建慢"可以定位到具体步骤。降档的用途很直接：agent 在会话中触发增量更新时不需要每次都重算社区。

## 三入口共享同一管线

CLI（`build`/`update`/`watch` 命令）、MCP 工具、watch 模式，走的是**同一条** `run_post_processing`——这正是该函数被抽成独立模块的原因（其 docstring，postprocessing.py:16-17："every entry point … produces identical results"）。三个入口的差异只在触发方式：

- **CLI**：一次性命令，由人或 CI 触发，适合初始构建与定时重建；
- **MCP**：AI 助手在会话中调用工具，触发增量更新或纯查询；
- **watch**：watchdog 文件系统事件驱动，1 秒防抖批处理后跑增量更新（`_DEBOUNCE_SECONDS = 1`，incremental.py:1568）。

共享管线消除了"不同入口建出不同的图"这一整类 bug——任何入口修复的解析问题，所有入口同时受益。

## daemon 的位置：编排器，不是服务

`WatchDaemon`（`code_review_graph/daemon.py:644`）常被误认为是中心服务，这是误解。它只做一件事：**为每个被监听的仓库 fork 一个 `code-review-graph watch` 子进程并看管它们**。架构约束非常克制：

- 每仓库一个独立子进程，进程间**没有 IPC**；
- 状态全部落在 `daemon-state.json`（路径由 `daemon.py:56` 给出）：PID、仓库路径、启动时间；
- 存活探测用 `os.kill(pid, 0)`（daemon.py:487），优雅退出靠 SIGTERM/SIGHUP 处理器（`_setup_signal_handlers`，daemon.py:1154）；
- 不依赖任何外部进程管理器（tmux/screen/systemd 都不用，见其 docstring）。

daemon 自身崩溃或重启不损失任何东西——状态文件加 PID 探测足以重建对子进程的完整视图。它是"看护进程列表的脚本"，不是"必须在线的服务"。

## 解耦的关键：共享 SQLite（WAL）

写入侧（watch 子进程、增量更新）与查询侧（MCP 服务）之间**没有任何进程内通信**，它们只共享同一个 SQLite 数据库文件，靠 `PRAGMA journal_mode=WAL`（graph.py:196）实现读写并发：

- 查询进程读一致性快照，不被写入阻塞；
- 写入进程受 SQLite 单写者约束，由 `BEGIN IMMEDIATE` 串行化。

这个选择把一个分布式系统问题（实时索引服务如何与查询服务同步）降级成一个文件系统问题（两个进程打开同一个文件），换来的是：

- MCP 查询服务完全无状态，随时重启、随时多开；
- 多个 AI 助手会话可以并发查询同一份图；
- 没有端口、socket、协议需要维护和排错；
- 备份/迁移/检查图就是拷一个文件。

代价是单机限制——WAL 不支持网络文件系统（NFS 上锁语义不可靠），也无法跨机共享。这与项目"本地优先"（local-first）的定位一致：图跟着仓库走，跟随开发者的机器走。

## 关键文件索引

| 关注点 | 文件 | 入口 |
|---|---|---|
| 管线编排 | `code_review_graph/postprocessing.py` | `run_post_processing` (:31) |
| 文件发现 | `code_review_graph/incremental.py` | `collect_all_files` (:1027) |
| 解析核心 | `code_review_graph/parser.py` | `CodeParser.parse_bytes` (:2600) |
| 存储核心 | `code_review_graph/graph.py` | `store_file_nodes_edges` (:359) |
| 增量/监听 | `code_review_graph/incremental.py` | `resolve_incremental_base` (:812) 等 |
| 多仓库看护 | `code_review_graph/daemon.py` | `WatchDaemon` (:743) |

## 失败模式速查

理解一个系统的边界，最快的方法是看它在各处如何失败：

- **坏 grammar**：子进程探活失败 → 该语言跳过，构建继续（parser.py:475）；
- **解析中文件被改写**：不可能读到混合内容——哈希与解析作用于同一份字节（parse_bytes）；
- **写入中途崩溃**：事务回滚，该文件保持旧版本完整数据（BEGIN IMMEDIATE + 单文件事务）；
- **某个后处理步骤失败**：记 warning，其余步骤照常（postprocessing.py 各 `_step` 的 try/except）；
- **watch 子进程死亡**：daemon 通过 PID 探测发现，按指数退避重启（30s 起步、900s 封顶）；observer 卡死但不退出则不重启，只把状态标成 stalled 留给人判断——详见第 8 章；
- **MCP 查询时图正在被重写**：WAL 快照读，查询看到的是写入开始前的一致性版本。

没有任何一种失败需要人工介入修复数据——最坏的恢复路径是删掉数据库重新全量构建，而全量构建只是这条管线的慢速重放。

## 横切面：环境变量即配置

管线各阶段的旋钮集中以 `CRG_*` 环境变量暴露，没有独立的配置文件体系：

- `CRG_DEPENDENT_HOPS`：依赖扇出跳数（默认 2，incremental.py:1136）；
- `CRG_MAX_IMPACT_NODES` / `CRG_IMPACT_DEPTH_DECAY` / `CRG_IMPACT_SCORE_FLOOR`：影响半径的上限、衰减、地板（constants.py:43/94/97）；
- `CRG_MAX_WATCH_SCHEDULES` / `CRG_WATCH_PLAN_DEPTH`：watch 槽位预算与规划深度（incremental.py:1601-1602）；
- `CRG_LEIDEN_SEED`：社区检测随机种子（默认 42，communities.py:21）；
- `CRG_MAX_CHANGED_FUNCS`：变更函数截断（默认 500，changes.py:441）。

这个选择同样服务于"本地优先 + agent 驱动"：环境变量对 shell、CI、MCP 配置注入都同样廉价，且不需要为配置解析维护一套 schema。代价是可发现性差——有哪些旋钮得读源码（本书各章已把主要的列出来了）。
