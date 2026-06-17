# 全部可用命令

## 技能与斜杠命令

这些命令为支持项目技能或斜杠命令风格工作流的客户端安装。

### `/code-review-graph:build-graph`
构建或更新知识图谱。
- 首次：执行完整构建
- 后续：增量更新（仅变更文件）

### `/code-review-graph:review-delta`
仅审查自上次提交以来的变更。
- 通过 git diff 自动检测变更文件
- 计算影响半径（默认 2 跳）
- 生成带指导的结构化审查

### `/code-review-graph:review-pr`
审查 PR 或分支 diff。
- 使用 main/master 作为基准
- 跨所有 PR 提交的完整影响分析
- 含风险评估的结构化输出

## MCP 工具

### 核心工具

#### `build_or_update_graph_tool`
```
full_rebuild: bool = False           # True 表示全部重新解析
repo_root: str | None                # 自动检测
base: str = "HEAD~1"                 # 增量更新的 VCS diff 基准
postprocess: str = "full"            # "full"、"minimal" 或 "none"
recurse_submodules: bool | None      # 回退到 CRG_RECURSE_SUBMODULES
```

#### `run_postprocess_tool`
```
flows: bool = True
communities: bool = True
fts: bool = True
repo_root: str | None
```

#### `get_minimal_context_tool`
```
task: str = ""                       # 你正在做什么
changed_files: list[str] | None      # 省略时从 VCS 自动检测
repo_root: str | None
base: str = "HEAD~1"
```

#### `get_impact_radius_tool`
```
changed_files: list[str] | None  # 从 VCS 自动检测
max_depth: int = 2               # 图谱跳数
repo_root: str | None
base: str = "HEAD~1"
detail_level: str = "standard"   # "standard" 或 "minimal"
```
相关响应可能包含精简的预估 `context_savings` 元数据。

#### `query_graph_tool`
```
pattern: str    # callers_of、callees_of、imports_of、importers_of、
                # children_of、tests_for、inheritors_of、file_summary
target: str     # 节点名、限定名或文件路径
repo_root: str | None
detail_level: str = "standard"   # "standard" 或 "minimal"
```

#### `get_review_context_tool`
```
changed_files: list[str] | None
max_depth: int = 2
include_source: bool = True
max_lines_per_file: int = 200
repo_root: str | None
base: str = "HEAD~1"
detail_level: str = "standard"   # "standard" 或 "minimal"
```
相关响应可能包含精简的预估 `context_savings` 元数据。

#### `traverse_graph_tool`
```
query: str
depth: int = 3                  # 1-6
mode: str = "bfs"               # "bfs" 或 "dfs"
token_budget: int = 2000
repo_root: str | None
```

#### `semantic_search_nodes_tool`
```
query: str           # 搜索字符串
kind: str | None     # File、Class、Function、Type、Test
limit: int = 20
repo_root: str | None
model: str | None    # 嵌入模型（回退到 CRG_EMBEDDING_MODEL 环境变量）
provider: str | None # local、openai、google、minimax
detail_level: str = "standard"
```

#### `embed_graph_tool`
```
repo_root: str | None
model: str | None    # 嵌入模型名称
provider: str | None # local、openai、google、minimax
```
本地嵌入需要：`pip install code-review-graph[embeddings]`。云提供者使用标准库 HTTP 客户端并需要对应的环境变量。

#### `list_graph_stats_tool`
```
repo_root: str | None
```

#### `find_large_functions_tool`
```
min_lines: int = 50                # 最小行数阈值
kind: str | None                   # File、Class、Function 或 Test
file_path_pattern: str | None      # 按文件路径子串过滤
limit: int = 50                    # 最大返回结果数
repo_root: str | None
```

#### `get_docs_section_tool`
```
section_name: str    # usage、review-delta、review-pr、commands、legal、watch、embeddings、languages、troubleshooting
```

### 流工具

#### `list_flows_tool`
```
sort_by: str = "criticality"  # criticality、depth、node_count、file_count、name
limit: int = 50
kind: str | None              # 按入口点类型过滤（如 "Test"、"Function"）
repo_root: str | None
detail_level: str = "standard"
```

#### `get_flow_tool`
```
flow_id: int | None          # 来自 list_flows_tool 的数据库 ID
flow_name: str | None        # 要搜索的名称（部分匹配）
include_source: bool = False # 为每步包含源片段
repo_root: str | None
```

#### `get_affected_flows_tool`
```
changed_files: list[str] | None  # 从 VCS 自动检测
base: str = "HEAD~1"
repo_root: str | None
```

### 社区工具

#### `list_communities_tool`
```
sort_by: str = "size"    # size、cohesion、name
min_size: int = 0
repo_root: str | None
detail_level: str = "standard"
```

#### `get_community_tool`
```
community_name: str | None   # 要搜索的名称（部分匹配）
community_id: int | None     # 数据库 ID
include_members: bool = False
repo_root: str | None
```

#### `get_architecture_overview_tool`
```
repo_root: str | None
detail_level: str = "minimal"    # "minimal" 精简默认，"standard" 完整详情
```
精简响应可能包含精简的预估 `context_savings` 元数据。

### 图谱健康与架构工具

#### `get_hub_nodes_tool`
```
top_n: int = 10
repo_root: str | None
```

#### `get_bridge_nodes_tool`
```
top_n: int = 10
repo_root: str | None
```

#### `get_knowledge_gaps_tool`
```
repo_root: str | None
```

#### `get_surprising_connections_tool`
```
top_n: int = 15
repo_root: str | None
```

#### `get_suggested_questions_tool`
```
repo_root: str | None
```

### 变更分析与重构工具

#### `detect_changes_tool`
```
base: str = "HEAD~1"
changed_files: list[str] | None
include_source: bool = False
max_depth: int = 2
repo_root: str | None
detail_level: str = "standard"
```
代码审查的主工具。将变更文件映射到受影响的函数、流、社区和测试覆盖缺口。返回风险评分和优先排序的审查项。
相关响应可能包含精简的预估 `context_savings` 元数据。

#### `refactor_tool`
```
mode: str = "rename"         # "rename"、"dead_code" 或 "suggest"
old_name: str | None         # (rename) 当前符号名
new_name: str | None         # (rename) 新名称
kind: str | None             # (dead_code) Function 或 Class
file_pattern: str | None     # (dead_code) 按文件路径子串过滤
repo_root: str | None
```

#### `apply_refactor_tool`
```
refactor_id: str             # 来自先前 refactor_tool 调用的 ID
repo_root: str | None
dry_run: bool = False        # 返回 diff 而不写入文件
```

### Wiki 工具

#### `generate_wiki_tool`
```
repo_root: str | None
force: bool = False          # 即使未变更也重新生成所有页面
```

#### `get_wiki_page_tool`
```
community_name: str          # 要查找的社区名称
repo_root: str | None
```

### 多仓库工具

#### `list_repos_tool`
```
（无参数）
```

#### `cross_repo_search_tool`
```
query: str
kind: str | None
limit: int = 20
```

## MCP 提示词（5 个工作流模板）

### `review_changes`
使用 detect_changes、affected_flows 和测试缺口的预提交审查工作流。
```
base: str = "HEAD~1"
```

### `architecture_map`
使用社区、流和 Mermaid 图的架构文档。

### `debug_issue`
使用搜索、流追踪和最近变更的引导式调试。
```
description: str = ""
```

### `onboard_developer`
使用统计、架构和关键流的新开发者入职。

### `pre_merge_check`
带风险评分、测试缺口和死代码检测的 PR 就绪检查。
```
base: str = "HEAD~1"
```

## CLI 命令

```bash
# 设置
code-review-graph install           # 配置检测到的 AI 编码平台（别名：init）
code-review-graph install --dry-run # 预览而不写入文件
code-review-graph install --platform codex  # 配置单个平台

# 构建和更新
code-review-graph build                        # 完整构建
code-review-graph build --skip-flows           # 仅解析 + 签名 + FTS
code-review-graph build --skip-postprocess     # 仅原始解析
code-review-graph update                       # 增量更新
code-review-graph update --base origin/main    # 自定义基准引用
code-review-graph update --brief               # 更新图谱 + 显示风险面板
code-review-graph update --brief --verify      # ...并与 tiktoken 交叉核对
code-review-graph postprocess                  # 重新运行流、社区、FTS
code-review-graph embed --provider local       # 计算向量嵌入用于语义搜索

# 监控和检查
code-review-graph status                       # 图谱统计
code-review-graph watch                        # 文件变更时自动更新
code-review-graph visualize                    # 生成交互式 HTML 图谱
code-review-graph visualize --format graphml   # 导出 GraphML
code-review-graph visualize --serve            # 在 localhost:8765 提供图谱

# 分析
code-review-graph detect-changes               # 风险评分变更分析
code-review-graph detect-changes --base HEAD~3 # 自定义基准引用
code-review-graph detect-changes --brief        # 带 Token 节省估算的精简面板
code-review-graph detect-changes --brief --verify  # ...并与 tiktoken 交叉核对

# detect-changes 与 update --brief —— 用哪个？
# • detect-changes --brief：只读。问"对现有图谱，我当前的
#   变更有什么影响？"速度快（~1s）。当图谱已是最新时使用
#   （即你已安装钩子时的默认情况）。
# • update --brief：先重新解析变更文件到图谱中，然后
#   在结尾运行相同分析。在 rebase 后、大变更集后或
#   当你怀疑图谱过期时使用。
# 两者都以相同的 "Token Savings" 面板结束。

# Wiki
code-review-graph wiki                         # 从社区生成 Markdown Wiki

# 多仓库
code-review-graph register <path> [--alias name]  # 注册仓库
code-review-graph unregister <path_or_alias>       # 从注册表移除
code-review-graph repos                            # 列出已注册仓库

# 守护进程（多仓库监视器）——随 install 附带，无需额外依赖
code-review-graph daemon start [--foreground]       # 启动监视守护进程
code-review-graph daemon stop                       # 停止守护进程
code-review-graph daemon restart [--foreground]     # 重启守护进程
code-review-graph daemon status                     # 显示守护进程状态和仓库
code-review-graph daemon logs [--repo ALIAS] [--follow]  # 查看守护进程或每仓库日志
code-review-graph daemon add <path> [--alias NAME]  # 向守护进程配置添加仓库
code-review-graph daemon remove <path_or_alias>     # 从守护进程配置移除仓库

# 评估
code-review-graph eval                         # 运行评估基准

# 服务器
code-review-graph serve                        # 启动 MCP 服务器（stdio）
code-review-graph serve --http                 # 流式 HTTP 在 localhost:5555
code-review-graph serve --tools query_graph_tool,detect_changes_tool  # 工具白名单
code-review-graph mcp                          # serve 的别名
```

## 独立守护进程 CLI（`crg-daemon`）

`crg-daemon` 命令随每次 `code-review-graph` 安装附带——无需单独安装。它也可作为独立入口点使用。它与 `code-review-graph daemon` 子命令镜像：

```bash
crg-daemon start [--foreground]       # 启动多仓库监视守护进程
crg-daemon stop                       # 停止守护进程及所有监视进程
crg-daemon restart [--foreground]     # 重启（stop + start）
crg-daemon status                     # 显示守护进程状态、仓库和进程存活
crg-daemon logs [--repo ALIAS] [-f] [-n N]  # 追踪守护进程或每仓库日志文件
crg-daemon add <path> [--alias NAME]  # 向 watch.toml 添加仓库
crg-daemon remove <path_or_alias>     # 从 watch.toml 移除仓库
```

### 配置

守护进程从 `~/.code-review-graph/watch.toml` 读取其配置：

```toml
session_name = "crg-watch"   # 逻辑守护进程名称
log_dir = "~/.code-review-graph/logs"
poll_interval = 2            # 配置文件轮询间隔秒数

[[repos]]
path = "/home/user/project-a"
alias = "project-a"

[[repos]]
path = "/home/user/project-b"
alias = "project-b"
```

守护进程为每个仓库生成一个 `code-review-graph watch` 子进程，通过 `subprocess.Popen` 管理。它监控配置文件变更并自动协调子进程（随着仓库添加/移除而启动/停止）。健康检查每 30 秒运行一次并自动重启死掉的监视器。无需外部依赖（tmux、screen 等）。
