# 功能特性

## v2.3.6（当前版本）
- **无需 fork 即可自定义语言**：在仓库中放置 `.code-review-graph/languages.toml` 来索引 tree-sitter-language-pack 提供的任何语法——扩展名映射加上节点类型列表，经过验证和上限约束，内置语言始终优先。参见 [CUSTOM_LANGUAGES.md](CUSTOM_LANGUAGES.md)。
- **风险评分 PR 审查的 GitHub Action**：复合 `action.yml` 从 CI 缓存构建/恢复图谱，对 PR 基准分支运行 `detect-changes`，并更新一个包含风险表、受影响流、测试缺口和 Token Savings 行的置顶评论。可选 `fail-on-risk` 合并门控。通过 `.github/workflows/pr-review.yml` 在本仓库中自行验证。参见 [GITHUB_ACTION.md](GITHUB_ACTION.md)。
- **`agent_baseline` 评估基准**：将图谱查询与现实的 grep-and-read-top-k 代理基线进行对比，而非全语料库的比较基准；已接入所有六个固定的评估配置。
- **影响准确性的协同变更真值**：预测还会与同一提交中实际协同变更的文件进行对比评分；旧指标明确标注为"图谱推导（循环——上限）"。
- **每周评估 CI**：`.github/workflows/eval.yml` 对两个最小的固定配置运行仅报告的定时任务，含 CSV 产物和作业摘要。
- **docs/FAQ.md**：CRG 与 LSP、RAG、grep/代理搜索及相邻工具的对比；何时不该使用；验证步骤；monorepo/worktree 和注册表指南。
- **贡献脚手架**：GitHub issue 表单（bug/feature/platform）、与 CONTRIBUTING 清单对应的 PR 模板，以及 pip + GitHub Actions 的 dependabot 配置。
- **Windows 修复**：`daemon status` 不再因 WinError 87 崩溃（#511），CLI `detect-changes` 将 diff 路径映射为绝对原生路径（#528）。
- **提供者名称验证**：未知的嵌入提供者名称会引发指明有效提供者的明确错误，而非静默回退到本地模型。
- **存储泄漏修复**：五个分析 MCP 工具和 wiki 页面工具不再泄漏 SQLite 连接（try/finally `store.close()`）。
- **`fastmcp<4` 上限**：下一个 fastmcp 主版本不再静默破坏服务器。
- **Worktree 安全的 git 钩子**：`install` 通过 `git rev-parse --git-path hooks` 解析真实的钩子目录，因此链接的 worktree 和 `core.hooksPath`（husky）配置也能正常工作。

## v2.3.5
- **每次简要 CLI 调用的 Token Savings 面板**：`code-review-graph detect-changes --brief` 和新的 `code-review-graph update --brief` 打印一个带框的 `Token Savings` 面板——完整上下文基线、图谱响应、节省 Token、百分比和按类别细目（函数 / 测试 / 风险 / 其他），总和精确等于图谱响应大小。
- **`--verify` 标志**：与 OpenAI 的 `cl100k_base` 分词器（GPT-4 系列）交叉核对显示的数字。增加第二行 `Verified (tiktoken)` 显示真实 Token 计数。对 222 个多语言文件的校准显示预估在总量上与真实 Token 偏差约 ~1%。
- **`update --brief`**：增量更新 + 一个命令中的风险面板。与 `detect-changes --brief`（对现有图谱只读）不同——在图谱可能过期时使用 update（rebase 后、大变更集后）。
- **`code-review-graph embed` CLI 子命令**：显式 shell 级别的嵌入生成访问。此前只能通过 MCP 访问。
- **确定性评估管道**：所有 6 个评估配置固定上游 SHA，`eval/runner.py` 使用完整克隆并显式 `returncode` 检查，Leiden 社区检测使用固定种子（`CRG_LEIDEN_SEED=42`）。不同机器上的两次运行产生相同数字。
- **`multi_hop_retrieval` 基准**：6 个测试仓库中 11 个手工策划的 2 步工具链任务。平均得分 0.909。
- **更丰富的语义搜索**：`embeddings._node_to_text` 现在包含点分形式（`Module.Class.method`）、分词标识符和封闭模块目录。自然语言查询的搜索排序从 0.545 提升到 0.909（多跳基准）。
- **标识符感知搜索增强**：`extract_query_identifiers` 从自然语言查询中提取点分 / snake_case / CamelCase 标识符，并在混合搜索中将匹配的限定名增强 ×2.0。
- **路径规范化修复**：`eval/runner.py` 在存储前绝对解析仓库路径，使评估构建的图谱与 CLI/MCP 构建的图谱匹配。
- **测试缺口去重**：简要摘要中的 `Untested:` 行按裸名去重。
- **FTS5 评估中自动重建**：评估框架在 `full_build` 后调用 `run_post_processing`，因此 FTS5 自动填充而非留空索引。

## v2.3.4
- **预估 Token 节省**：审查、影响、检测变更和精简架构响应包含小型 `context_savings` 元数据。
- **默认精简架构概览**：`get_architecture_overview_tool` 默认 `detail_level="minimal"` 以避免大型成员列表和每边负载。使用 `detail_level="standard"` 获取完整详情。
- **有界变更分析**：`CRG_MAX_CHANGED_FUNCS`、`CRG_MAX_TRANSITIVE_FRONTIER` 和 `CRG_TOOL_TIMEOUT` 帮助保持大型 MCP 审查调用的响应性。
- **Windows MCP 可靠性**：本地嵌入模型在 FastMCP 启动 worker 分发前预热，以避免语义搜索死锁。
- **解析器正确性**：Rust `#[test]` 和常见异步测试属性现在生成 `Test` 节点。
- **图谱查找正确性**：审查、影响和文件摘要工具将用户路径解析为存储的图谱路径。
- **安装/运行时可靠性**：生成的 Codex/Claude 钩子排空 stdin，打包的文档可从 wheel 获取。
- **CLI 可靠性**：`build --skip-postprocess` 和 `update --skip-flows` 遵循请求的后处理级别。
- **广泛解析器覆盖**：Python、JavaScript/TypeScript/TSX、Go、Rust、Java、C/C++、C#、Ruby、Kotlin、Swift、PHP、Scala、Solidity、Dart、R、Perl、Lua/Luau、Objective-C、Shell 脚本、Elixir、Zig、PowerShell、Julia、ReScript、GDScript、Nix、Verilog/SystemVerilog、SQL、Vue/Svelte SFC、Astro 文件、Jupyter/Databricks 笔记本和 Perl XS 文件。
- **本地优先设计**：SQLite 图谱存储保持本地，无遥测，无云默认行为。

## v2.0.0
- **22 个 MCP 工具**（从 9 个增加）：13 个新工具用于流、社区、架构、重构、Wiki、多仓库和风险评分变更检测。
- **5 个 MCP 提示词**：`review_changes`、`architecture_map`、`debug_issue`、`onboard_developer`、`pre_merge_check` 工作流模板。
- **18 种语言**（从 15 种增加）：新增 Dart、R、Perl 支持。
- **执行流**：从入口点（HTTP 处理程序、CLI 命令、测试）追踪调用链，按关键性评分排序。
- **社区检测**：通过 Leiden 算法（igraph）或基于文件的分组聚类相关代码实体。
- **架构概览**：自动生成的架构图，含模块摘要和跨社区耦合警告。
- **风险评分变更检测**：`detect_changes` 将 git diff 映射到受影响的函数、流、社区和测试覆盖缺口。
- **重构工具**：带编辑列表的重命名预览、死代码检测、社区驱动的重构建议。
- **Wiki 生成**：为每个社区自动生成 Markdown Wiki 页面，可选 LLM 摘要（ollama）。
- **多仓库注册表**：注册多个仓库，使用 `cross_repo_search` 跨所有仓库搜索。
- **全文搜索**：FTS5 虚拟表，带 Porter 词干提取，用于混合关键词 + 向量搜索。
- **数据库迁移**：版本化模式迁移（v1-v5），启动时自动升级。
- **可选依赖组**：`[embeddings]`、`[google-embeddings]`、`[communities]`、`[eval]`、`[wiki]`、`[all]`。
- **评估框架**：带 matplotlib 可视化的基准套件。
- **TypeScript 路径解析**：tsconfig.json paths/baseUrl 别名解析。
- **486 个测试**，分布 22 个测试文件。

## v1.8.4
- **多词 AND 搜索**：`search_nodes` 现在要求所有词匹配（不区分大小写）。
- **调用目标解析**：裸调用目标使用同文件定义解析为限定名。
- **影响半径分页**：`get_impact_radius` 返回 `truncated` 标志和 `total_impacted` 计数。
- **`find_large_functions_tool`**：新 MCP 工具查找超过行数阈值的函数、类或文件。
- **15 种语言**：新增 Vue SFC 和 Solidity 支持。
- **文档刷新**：精确保真的语言/工具计数、版本引用和 VS Code 扩展对等性。

## v1.8.3
- **解析器递归保护**：`_MAX_AST_DEPTH = 180` 防止深度嵌套 AST 栈溢出。
- **模块缓存上限**：`_MODULE_CACHE_MAX = 15,000` 带自动淘汰。
- **嵌入线程安全**：EmbeddingStore SQLite 上 `check_same_thread=False`。
- **嵌入重试逻辑**：Google Gemini API 调用的指数退避。
- **可视化 XSS 加固**：`</` 在 JSON 序列化中转义为 `<\/`。
- **CLI 错误处理**：将宽泛的 `except` 拆分为特定处理程序。
- **Git 超时**：通过 `CRG_GIT_TIMEOUT` 环境变量可配置。
- **治理文件**：CONTRIBUTING.md、SECURITY.md、CODE_OF_CONDUCT.md。

## v1.8.2
- **C# 解析修复**：语言标识符从 `c_sharp` 重命名为 `csharp`。
- **监视模式线程安全**：SQLite 连接兼容 Python 3.10/3.11 watchdog 线程。
- **完整重建清理**：在完整重建期间清除已删除文件的过期数据。
- **依赖修剪**：移除未使用的 `gitpython` 依赖。

## v1.7.0
- **`install` 命令**：新的安装主入口（`init` 保留为别名）。
- **`--dry-run` 标志**：预览 `install`/`init` 将写入什么而不修改文件。
- **PyPI 自动发布**：GitHub release 现在自动发布到 PyPI。
- **README 重写**：专业文档，含来自 httpx、FastAPI 和 Next.js 的真实基准数据。

## v1.6.4
- **可移植 MCP 配置**：`init` 现在生成基于 `uvx` 的 `.mcp.json`——无绝对路径，任何有 `uv` 的机器都能工作
- **移除符号链接变通方案**：有了 `uvx`，不再需要 `_safe_path` 辅助函数

## v1.6.3
- **SessionStart 钩子**：Claude Code 在会话开始时自动偏好图谱 MCP 工具
- **市场就绪**：plugin.json 已更正，用于官方 Claude Code 插件市场提交
- **README 清理**：移除截图占位符

## v1.6.2
- **24 个审计修复**：关键 bug 修复、性能改进、解析器增强、扩展测试覆盖
- **解析器：C/C++ 支持**：C 和 C++ 的完整节点提取（类、函数、导入、调用、继承）
- **解析器：名称提取**：修复了 Kotlin、Swift、Ruby
- **性能**：NetworkX 图缓存、批量边查询、分块嵌入搜索、git 子进程超时
- **CI 加固**：覆盖率强制（50%）、bandit 安全扫描、mypy 类型检查
- **测试**：+40 个新测试，覆盖增量更新、嵌入和 7 个新语言 fixture
- **文档**：API 响应模式、忽略模式文档、钩子配置参考修复
- **可访问性**：D3.js 可视化中全程添加 ARIA 标签

## v1.5.3
- **路径中的空格处理**：*（v1.6.4 被 `uvx` 配置取代）* 此前使用符号链接
- **无需 git**：`build`、`status`、`visualize`、`watch` 可在任何目录上工作
- **插件就绪**：技能在 plugin.json 中注册
- **文件组织**：生成文件移至 `.code-review-graph/` 目录
- **可视化密度**：默认折叠（仅 File 节点），搜索栏，可点击边类型切换，大规模图谱感知布局
- **项目清理**：移除冗余的 `references/`、`agents/`、`settings.json`

## v1.4.0
- **`init` 命令**：自动为 Claude Code 集成设置 `.mcp.json`
- **交互式 D3.js 图谱可视化**：`code-review-graph visualize` 生成可在浏览器中探索的 HTML 图谱
- **文档刷新**：所有参考文件的全面文档审计

## v1.3.0
- **带 Docker 回退的 Python 版本检查**：自动检测 Python 3.10+，不可用则建议 Docker
- **通用安装**：`pip install code-review-graph`——无需 git clone
- **CLI 入口点**：pip install 后 `code-review-graph` 命令全局可用

## v1.2.0
- **日志改进**：代码库全流程结构化日志
- **监视防抖**：更智能的文件变更检测
- **tools.py 修复**：MCP 工具的 bug 修复和可靠性改进
- **CI 覆盖**：带测试覆盖报告的 GitHub Actions CI/CD 管道

## v1.1.0
- **监视模式**：`code-review-graph watch`——文件变更时自动重建图谱
- **向量嵌入**：可选 `pip install .[embeddings]` 用于语义代码搜索
- **Go、Rust、Java 验证**：12+ 种语言，有专用测试覆盖
- **47 个测试通过**，8 个 MCP 工具已注册
- README 徽章和更简洁的安装流程

## v1.0.0（基础版本）
- **持久化 SQLite 知识图谱**——零外部依赖
- **Tree-sitter 多语言解析**——类、函数、导入、调用、继承
- **增量更新**——通过 `git diff` + 自动依赖级联
- **影响半径 / 影响半径分析**——通过调用/导入/继承图谱进行 BFS
- **6 个 MCP 工具**用于完整图谱交互
- **3 个审查优先技能**：build-graph、review-delta、review-pr
- **PostToolUse 钩子**（Write|Edit|Bash）用于自动后台更新
- **FastMCP 3.0 兼容**的 stdio MCP 服务器

## 隐私与数据
- 核心图谱数据存储在本地
- 图谱存储在 `.code-review-graph/graph.db`（SQLite），自动 gitignore
- 无遥测；核心图谱/审查工作流无需网络访问
- 可选的嵌入和 Wiki 功能仅在显式启用时可能调用配置的本地或远程服务
- 遵守 `.gitignore` 和 `.code-review-graphignore`
