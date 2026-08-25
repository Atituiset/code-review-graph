# 查询引擎：影响半径、流、社区与风险评分

图建好之后，查询引擎回答四类问题：这次变更波及谁（影响半径）、代码怎么执行（流）、代码怎么分组（社区）、这次变更有多危险（风险评分）。共同的设计取向：**重活离线预计算，查询期只做有界 SQL**——查询路径上不允许出现与图规模成正比的工作。

## 影响半径：SQLite 内的有界松弛

`get_impact_radius_sql`（`graph.py:1371`）回答"改了这些文件，哪些节点受影响"。它**不**物化 NetworkX 全图（早期方案，大图上内存与启动开销都不可接受），而是在 SQLite 内用临时表做 best-score 松弛。NetworkX 版本的 `get_impact_radius`（graph.py:1337，Python 侧 BFS）仍保留在代码里作为对照与后备（`CRG_BFS_ENGINE=networkx` 可切换），但默认路径已是 SQL 版——其 docstring 直言动机："Faster than NetworkX for large graphs because it avoids materialising the full graph in Python"。

### 算法结构

- 三张核心临时表 `_impact_best` / `_impact_frontier` / `_impact_next`，各以 qualified name 为主键、**每个节点至多一行**（存迄今最优分数），外加种子表 `_impact_seeds` 和策略表 `_impact_policies`（建表见 graph.py:1412-1452）；种子按 450 一批插入——SQLite 变量数上限的妥协；
- 为什么不递归 CTE 枚举路径：稠密带环图的路径数是指数级的，而"每节点保留最优分"只需每轮迭代扫一遍边表，复杂度压到 O（深度 × 边数）。graph.py 内的注释把这一点写得很明白；
- 分数语义：种子节点 1.0，每沿一条边传播乘以该边类型的权重，再按深度乘 0.6 衰减（`IMPACT_DEPTH_DECAY`，环境变量 `CRG_IMPACT_DEPTH_DECAY` 可调）。

### 截断阀

- 分数低于 **0.05 地板**（`CRG_IMPACT_SCORE_FLOOR`，constants.py:97）停止传播——深层弱影响直接丢弃；
- 受影响节点总数 **500 封顶**（`MAX_IMPACT_NODES`，constants.py:43，环境变量 `CRG_MAX_IMPACT_NODES`），超限时返回 `truncated: true` 而非静默丢数据。

这两个阀同时是正确性阀和 token 阀（见第 7 章）。种子选取也有个 C# 特例：C# 的命名空间字符串没有节点行，但 `using` 导入经命名空间桥接，所以 File 节点 `extra` 里存的声明命名空间会作为**桥接种子**注入，否则纯 C# 仓库的爆炸半径会系统性漏报（#310）。

### 方向感知的边语义

影响传播不是无向扩散。每种边有权重和方向（`IMPACT_EDGE_WEIGHTS` / `IMPACT_EDGE_DIRECTIONS`，constants.py:57-88）：

| 边类型 | 权重 | 传播方向 | 理由 |
|---|---|---|---|
| `CALLS` | 1.0 | 逆流 | 被调者变了，调用者遭殃 |
| `INHERITS`/`OVERRIDES`/`IMPLEMENTS` | 0.9 | 逆流 | 父类/接口变更传导给子类 |
| `TESTED_BY` | 0.7 | **顺流** | 刻意反向存储（生产 → 测试），变更顺流到达测试 |
| `REFERENCES`/`DEPENDS_ON` | 0.6 | 逆流 | 弱依赖 |
| `IMPORTS_FROM` | 0.5 | 逆流 | 最弱依赖 |
| `CONTAINS` | 0.3 | **不展开** | 改文件已种入文件内全部节点；沿 containment 走只会经陈旧边桥接进无关结构 |

方向规则的本质：依赖类边存的是"依赖者 → 被依赖者"，所以影响必须逆流（target → source）传播。未知边类型保守地按 incoming 处理——宁可多报潜在依赖者，不漏报。

`TESTED_BY` 的反向存储（生产节点 → 测试节点）初看反直觉，实则让这个模型自洽：改成顺流方向后，"这个函数变了，哪些测试该重跑"与"这个函数变了，哪些调用者会坏"用同一套传播机制回答，只是方向策略表里的不同条目。方向语义全部集中在 constants.py 的两张表里，算法本体（graph.py 的松弛循环）不含任何边类型的特例——新增边类型时只需登记权重和方向。

## 流（flows）：离线追踪，查询反查

执行流完全离线预计算（构建/更新时由 `_trace_flows` 触发），分两步：

### 入口点检测

`detect_entry_points`（flows.py:165 起）认定三类入口：

1. **真根**：没有任何入向 CALLS 边的函数；
2. **框架装饰器**：`@app.get` 之类的路由/handler 标记；
3. **约定命名**：`main`、`test_*` 等。

两个细节值得注意：统计被调方时**排除 File 节点发出的边**（flows.py:180 的注释）——否则模块顶层脚本调用（`run_job()`）和 JSX 顶层渲染（`<App />`）会让真正的入口"被调用"而漏检；测试节点默认排除（`include_tests=False`），让流分析聚焦生产路径。

### 前向 BFS 与 criticality

从每个入口沿 CALLS 边前向 BFS，**深度 15 封顶**（flows.py:226 的 `max_depth: int = 15`），得到"用户可见操作 → 内部实现"的执行路径。15 的上限意味着流只刻画主干调用结构，深层细节被有意丢弃。遍历用的是预加载的邻接表（`store.load_flow_adjacency()`）而不是逐跳查库——一次物化、多次复用。

每条流附带 criticality 评分 `compute_criticality`（flows.py:325），五因子加权：

| 因子 | 权重 |
|---|---|
| 文件跨度（1 文件 0 分，5+ 文件满分） | 0.30 |
| 安全敏感性 | 0.25 |
| 外部调用（目标是图外节点） | 0.20 |
| 测试覆盖缺口 | 0.15 |
| 深度 | 0.10 |

注意"外部调用"的定义：CALLS 目标不在 nodes 表里就算外部——第 2 章说的幽灵边/图外裸名在这里被**反向利用**为库依赖信号。

结果物化进 `flows` / `flow_memberships` 表。查询期（"这个节点属于哪些流"）只是对 `flow_memberships` 的 SQL 反查，**不做任何图遍历**。

## 社区（communities）：Leiden，可复现，可退化

`communities.py` 用 **Leiden 算法**（通过可选依赖 `igraph`）把图切成内聚社区：

- **resolution 随图规模对数下降**：`max(0.05, 1.0 / log10(n_nodes))`（communities.py:405）。注释解释了原因：默认 resolution=1.0 在 3 万节点以上的图会产生几千个碎社区，对数缩放让大图的社区更粗、更具架构可读性；
- **固定种子 42**（`_LEIDEN_SEED`，communities.py:21，可用 `CRG_LEIDEN_SEED` 改）：Leiden 是随机算法，固定种子让两次构建结果可复现，diff 友好、agent 推理链可回放；
- **无 igraph 时退化**：按目录分组兜底（`communities.py:470` 起的 file-based fallback）。结构性差很多，但保证功能链不断——社区参与风险评分，社区缺失会让风险模型缺一个因子。

社区结果同时写入 `community_summaries` 摘要表（v6），供架构概览类查询直接取用——这是第 7 章"查询不展开子图"原则在社区维度上的落点。

## detect_changes：从 diff 到风险分

代码审查的主管线，四步：

1. **diff 解析**：`git diff --unified=0`（`parse_git_diff_ranges`，changes.py:45），`_parse_unified_diff`（changes.py:148）把 hunk 头解析成每文件的变更行区间；入口 `parse_diff_ranges`（changes.py:125）先做 VCS 类型探测（SVN 走 `svn diff --summarize` 平行实现）；
2. **行区间 → 节点映射**：`map_changes_to_nodes`（changes.py:279）找 `line_start`/`line_end` 与变更区间相交的图节点；
3. **逐节点风险评分** `compute_risk_score`（changes.py:324 起），六项手工调参的加性因子：

| 因子 | 规则 | 上限 |
|---|---|---|
| 流参与 | 每属于一条流 +0.05 | 0.25 |
| 跨社区调用者 | 每个来自其他社区的调用者 +0.05 | 0.15 |
| 测试覆盖 | 无测试 0.30，每有一条覆盖边降一档：`0.30 − min(测试数/5, 1) × 0.25` | 5+ 条时降到 0.05 |
| 安全关键词 | 名称命中（auth/crypto/token 等） | +0.20 |
| 调用者数 | callers / 20 | 0.10 |
| 变更频率（可选 churn） | 近 90 天提交数 / 10（饱和截断），权重 0.15 | 0.15 |

测试覆盖因子里的"测试数"是**直接 + 传递**的合计：`get_transitive_tests`（graph.py:541）沿调用链向前追最多 1 跳（可配）、frontier 50 封顶——集成测试经中间层调到你，现在也算覆盖。带歧义标记的裸名边被跳过，不猜。

churn 因子默认关闭（opt-in）：它把 git 历史引入评分，成本是一次历史扫描，且"常改的文件更危险"对某些仓库是噪声而非信号——所以做成显式开关而不是默认行为。

4. **汇总**：影响半径 + 风险分 + 测试缺口合并成审查上下文（再经第 7 章的 token 裁剪输出）。

第 1 步的 VCS 探测意味着同一条管线也能服务非 git 仓库（`parse_diff_ranges` 的 docstring 说明它按仓库类型分发）；第 2 步行区间重叠判定完全依赖 nodes 表的 `line_start`/`line_end`——这也是解析期必须精确记录行号的原因，行号质量直接决定变更映射的召回率。

评分公式本身就是项目世界观的浓缩：一个节点危险，是因为它**在关键执行路径上**（流）、**是模块间的关节**（跨社区调用者）、**没有测试兜底**（TESTED_BY）、**碰敏感领域**（安全关键词）、**被很多人依赖**（调用者数）。没有任何一项来自类型系统或形式化分析——全部是对图结构的统计。

## 混合检索：两条腿的符号搜索

`hybrid_search`（search.py:309）是语义搜索的实现，结构是"两条独立腿 + 融合"：

- **BM25 腿**：FTS5 全文索引（第 2 章的 `nodes_fts`）按关键词匹配名字/路径/签名。查询词先做双引号包裹，防 FTS5 操作符注入；
- **向量腿**：嵌入表余弦扫描（第 4 章），无向量时静默缺席；
- **融合用 RRF**（`rrf_merge`，search.py:151）：每个结果按名次贡献 `1/(60+rank)`——只看名次不看原始分数，因此 BM25 与余弦两种不可通约的量纲无需归一化就能融合，k=60 压平名次差的抖动。

每条腿取 `limit×3` 个候选再融合，保证截断不发生在融合之前；两腿都空时退化到 LIKE 关键词匹配（精确 3.0 / 前缀 2.0 / 包含 1.0）。响应里的 `search_mode` 字段如实报告走了哪条路：`hybrid` / `fts` / `semantic` / `keyword` / `none`——与第 6 章的诚实清单一脉相承。

另有一层**查询形态感知**的加分（`detect_query_kind_boost`，search.py:102）：PascalCase 查询给 Class/Type 结果 ×1.5、snake_case 给 Function ×1.5、点分串按 qualified name 匹配 ×2.0、自然语言问句里出现的标识符在 qualified name 中命中 ×2.0——"程序员怎么写查询"被编码进了排序先验。

## 预计算的增量变体

流和社区的离线预计算在增量更新后不必全部重来，各自有一个聪明的变体：

- **incremental_trace_flows**（flows.py:459）：反查 `flow_memberships` 找出经过变更文件的流 → 在删除前快照它们的入口点（否则删完就忘了要重追谁）→ 显式事务内删除受影响的流（防中途崩溃留下孤儿 membership，#258）→ 只重追这些入口。无关的流原样保留；
- **incremental_detect_communities**（communities.py:849）：先数变更文件里的 DISTINCT community_id，为零直接返回；非零就整体重算——注释直言这是"correct and fast enough"的取舍：社区是全局性质，局部修补的正确性风险大于全算的成本，而跳过检查已经把"无关变更"的成本压到了一次 COUNT 查询。



## 已知局限

如实记录四条：

- **风险评分是手工调参的启发式**。所有权重和上限（0.25/0.15/0.30/0.20/0.10/0.15）都是经验值，没有基准集校准；适合做排序信号，不适合当概率解读；
- **整体风险取 max**。一次变更的整体分取所有变更节点的最大值——九个低风险函数加一个高分函数，只呈现最高分，其余九个的风险形态被掩盖；
- **test_gaps 的间接覆盖仍有限**。传递覆盖（默认 1 跳、frontier 50）补上了"集成测试经中间层调用"这一类，但继承 fixture、参数化测试、外部测试仓依然不可见，"无测试"的结论仍偏悲观——只是程度轻了；
- **流的 15 层深度截断**会让特别深的调用链（多层框架中间件、深递归服务）在途中断开，断点之后的节点不归属任何流，进而在风险评分的"流参与"因子上系统性得分偏低。

## 附：影响半径的核心 SQL 结构

`get_impact_radius_sql` 的临时表骨架（简化自 graph.py:1412-1452）：

```sql
CREATE TEMP TABLE _impact_seeds    (qn TEXT PRIMARY KEY);
CREATE TEMP TABLE _impact_policies (kind TEXT PRIMARY KEY,
                                    weight REAL NOT NULL,
                                    direction TEXT NOT NULL);
CREATE TEMP TABLE _impact_best     (node_qn TEXT PRIMARY KEY, score REAL NOT NULL);
CREATE TEMP TABLE _impact_frontier (node_qn TEXT PRIMARY KEY, score REAL NOT NULL);
CREATE TEMP TABLE _impact_next     (node_qn TEXT PRIMARY KEY, score REAL NOT NULL);
```

每轮迭代把 frontier 与 edges 按 direction 做半连接（half-join），命中边的另一端按 `分数 × 权重 × 0.6^深度` 计分写入 `_impact_next`（已有更高分则跳过），然后 frontier 与 next 交换。`INSERT OR IGNORE` / 主键冲突即"每节点保留最优分"的实现方式——经典 Dijkstra 松弛的 SQL 化：优先队列被"frontier 表 + 主键去重"替代，因为边权固定且轮数有界，不需要真正按分数排序弹出。

## 附：一个风险分的演算示例
设变更节点 `auth.tokens.rotate` 的情况：属于 3 条流、2 个跨社区调用者、无 TESTED_BY 边、名称命中 `token` 安全关键词、共 8 个调用者、未启用 churn：

- 流参与：3 × 0.05 = 0.15
- 跨社区调用者：2 × 0.05 = 0.10
- 测试覆盖：0.30（无测试）
- 安全关键词：+0.20
- 调用者数：8 / 20 = 0.40 → 封顶 0.10
- 合计：0.85 → 高风险

同一个函数如果有 5 条以上 TESTED_BY 边，测试项从 0.30 降到 0.05，总分掉到 0.60——模型里"补测试"是性价比最高的降险手段，这与设计意图一致。

## 附：一次影响传播的分数演算

从种子节点（改动函数，score=1.0）沿 CALLS 边逆流传播，权重 1.0、深度衰减 0.6：

- 深度 1：直接调用者，1.0 × 1.0 × 0.6 = 0.60
- 深度 2：调用者的调用者，0.60 × 1.0 × 0.6 = 0.36
- 深度 3：0.216；深度 4：0.130；深度 5：0.078；深度 6：0.047 → 低于 0.05 地板，停止

即纯 CALLS 链上，影响有效传播约 5 跳。若路径经过弱边（如 IMPORTS_FROM 0.5），衰减更快：0.5×0.6=0.30 → 0.09 → 0.027，约 2~3 跳即触地板。这个数值形态解释了为什么默认参数下结果通常"刚好覆盖一个模块及其直接邻居"——常数就是按这个直观调的。

多条路径到达同一节点时取最高分（best-score 松弛的语义），所以"一个节点同时是深层弱影响和浅层强影响"时呈现强影响的分数。
