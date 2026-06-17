# 架构

## 系统概述

`code-review-graph` 是一个本地优先的代码智能图谱，通过 CLI 和 MCP 服务器暴露。它维护一个持久化的、增量更新的代码库知识图谱，使 AI 编码工具能用结构化上下文审查变更，而非阅读广泛的文件转储。Claude Code 是受支持的客户端之一，但只是众多客户端中的一个。

## 组件图

```
┌──────────────────────────────────────────────────────────────┐
│                    AI 编码客户端 / CLI                         │
│                                                              │
│  MCP 客户端              钩子 / watch 模式                    │
│  ├── Codex                └── 增量更新                        │
│  ├── Claude Code                                             │
│  ├── Cursor, Windsurf, Zed, Continue                         │
│  └── Gemini CLI, Qwen, Qoder, Copilot, OpenCode              │
│          │                        │                          │
│          ▼                        ▼                          │
│  ┌────────────────────────────────────────────┐              │
│  │      MCP 服务器 (stdio 或 localhost HTTP)  │              │
│  │                                            │              │
│  │  30 个 MCP 工具 + 5 个 MCP 提示词          │              │
│  │  ├── 核心：build、impact、query、review、   │              │
│  │  │   search、traverse、embed、stats、docs  │              │
│  │  ├── 流：list、get、affected               │              │
│  │  ├── 社区：list、get、architecture         │              │
│  │  ├── 分析：detect_changes、refactor、      │              │
│  │  │   apply_refactor、hotspots、gaps        │              │
│  │  ├── Wiki：generate、get_page              │              │
│  │  └── 多仓库：list_repos、cross_search      │              │
│  └────────────────┬───────────────────────────┘              │
└───────────────────┼──────────────────────────────────────────┘
                    │
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
   ┌─────────┐ ┌─────────┐  ┌─────────────┐
   │  解析器  │ │  图谱    │  │  增量引擎    │
   │         │ │  存储    │  │             │
   └────┬────┘ └────┬────┘  └──────┬──────┘
        │           │              │
        ▼           ▼              ▼
   Tree-sitter   SQLite DB      git/svn diff
   语法解析      (.code-review- 子进程
                 graph/
                 graph.db)
```

## 数据流

### 完整构建
1. `collect_all_files()` 收集跟踪文件（`git ls-files`）并应用 `.code-review-graphignore`（有 git 时 gitignored 文件自动跳过）
2. 对每个文件，`CodeParser.parse_file()` 使用 Tree-sitter 提取 AST
3. AST 遍历器识别结构节点（类、函数、导入）和边（调用、继承）
4. `GraphStore.store_file_nodes_edges()` 持久化到 SQLite，带文件哈希用于变更检测
5. 元数据用时间戳更新

### 增量更新
1. `get_changed_files()` 使用 VCS 元数据识别变更文件（默认 git diff，增量层支持 SVN）
2. `find_dependents()` 查询图谱中导入变更文件的文件
3. 变更 + 依赖文件被重新解析（其他通过哈希比较跳过）
4. SQLite 中仅受影响的行被更新

### 审查上下文生成
1. 识别变更文件（git diff 或显式列表）
2. `get_impact_radius()` 从变更节点通过图谱进行 BFS
3. 仅提取变更区域的源片段
4. 生成审查指导（测试覆盖缺口、大影响半径警告）
5. 组装成结构化的、Token 高效的上下文供 MCP 客户端和 CLI 使用
6. 在可估算便宜基线的地方，附上精简的 `context_savings` 元数据作为估算而非精确分词

## 存储

### SQLite 模式
- **nodes** 表：id、kind、name、qualified_name、file_path、line_start/end、language、community_id 等
- **edges** 表：id、kind、source_qualified、target_qualified、file_path、line
- **metadata** 表：键值对（last_updated、build_type、schema_version）
- **flows** 表：id、name、entry_point_id、depth、node_count、file_count、criticality、path_json
- **flow_memberships** 表：flow_id、node_id、position
- **communities** 表：id、name、level、parent_id、cohesion、size、dominant_language、description
- **nodes_fts**（FTS5 虚拟表）：name、qualified_name、file_path、signature 上的全文搜索
- **community_summaries**、**flow_snapshots**、**risk_index** 表：用于 Token 高效查询的精简预计算摘要
- **embeddings** 表（单独的 DB）：qualified_name、vector、text_hash、provider

在 qualified_name、file_path、edge source/target、criticality、community_id 和 cohesion 上有索引，用于快速查找。

启用 WAL 模式以支持更新期间的并发读取。

### 限定名
节点通过限定名唯一标识：
- 文件：绝对路径（如 `/repo/src/auth.py`）
- 函数：`file_path::function_name`（如 `/repo/src/auth.py::authenticate`）
- 方法：`file_path::ClassName.method_name`（如 `/repo/src/auth.py::AuthService.login`）

## 解析策略

Tree-sitter 提供语言无关的 AST 访问。解析器：
1. 递归遍历 AST
2. 对节点类型进行模式匹配（`_CLASS_TYPES`、`_FUNCTION_TYPES` 等中的语言特定映射）
3. 提取名称、参数、返回类型、基类
4. 识别函数体内的调用
5. 将导入解析为模块路径

此方法在语法版本间比 tree-sitter 查询更健壮。

## 可视化

`visualization.py` 模块生成一个交互式 D3.js 力导向图作为自包含 HTML 文件。它从 SQLite 图谱存储读取所有节点和边并在浏览器中渲染，允许开发者可视化探索代码关系、按节点类型过滤和检查依赖。

## 影响分析算法

从种子节点（变更文件的内容）进行 BFS：
1. 种子 = 变更文件中的所有限定名
2. 对边界中的每个节点：
   - 跟随前向边（此节点影响到什么）
   - 跟随后向边（什么依赖此节点）
3. 扩展至 `max_depth` 跳（默认：2）
4. 收集所有到达的节点为"受影响"

这同时捕获下游影响（调用变更代码的事物）和上游上下文（变更代码依赖的事物）。
