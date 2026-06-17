# Code Review Graph — 用户指南

**适用版本：** v2.3.6

## 安装

```bash
pip install code-review-graph
code-review-graph install    # 自动检测并配置所有支持的平台
code-review-graph build      # 解析你的代码库
```

`install` 会检测你安装了哪些 AI 编码工具，为每个工具写入正确的 MCP 配置，并在支持的平台安装原生钩子。安装后请重启编辑器/工具。

若要针对特定平台而非自动检测所有平台：

```bash
code-review-graph install --platform codex
code-review-graph install --platform cursor
code-review-graph install --platform claude-code
```

### 支持的平台

| 平台 | 配置文件 |
|------|----------|
| **Codex** | `~/.codex/config.toml` + `~/.codex/hooks.json` |
| **Claude Code** | `.mcp.json` + `.claude/settings.json` |
| **Cursor** | `.cursor/mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Zed** | `.zed/settings.json` |
| **Continue** | `.continue/config.json` |
| **OpenCode** | `.opencode.json` |
| **Antigravity** | `~/.gemini/antigravity/mcp_config.json` |
| **Gemini CLI** | `.gemini/settings.json` |
| **Qwen Code** | `~/.qwen/settings.json` |
| **Kiro** | `.kiro/settings/mcp.json` |
| **Qoder** | `.qoder/mcp.json` |
| **GitHub Copilot** | `.vscode/mcp.json` |
| **GitHub Copilot CLI** | `~/.copilot/mcp-config.json` |

## 核心工作流

### 1. 构建图谱（仅首次）
```
/code-review-graph:build-graph
```
解析你的整个代码库。500 个文件约需 10 秒。

### 2. 审查变更（日常使用）
```
/code-review-graph:review-delta
```
仅审查自上次提交以来的变更文件以及图谱推导的影响半径。相关审查和影响响应包含精简的预估 `context_savings` 元数据。在 6 个基准测试仓库中，图谱查询每个问题使用的 Token 减少约 82 倍（中位数；范围 38×–528×）——详见 [README 基准测试](../README.md#benchmarks) 和 [REPRODUCING.md](REPRODUCING.md) 了解方法论。

### 3. 审查 PR
```
/code-review-graph:review-pr
```
对分支 diff 进行全面结构化审查，附带影响半径分析。

### 4. 监视模式（可选）
```bash
code-review-graph watch
```
每次文件保存时自动更新图谱，无需手动操作。

### 5. 可视化图谱（可选）
```bash
code-review-graph visualize
open .code-review-graph/graph.html
```
交互式 D3.js 力导向图。默认折叠（仅 File 节点）——点击文件可展开其子节点。使用搜索栏过滤，点击图例边类型切换可见性。

### 6. 语义搜索（可选）
```bash
pip install "code-review-graph[embeddings]"
```
然后使用 `embed_graph_tool` 计算向量。`semantic_search_nodes_tool` 在匹配嵌入可用时自动使用向量相似度，否则回退到关键词/FTS 搜索。

嵌入提供者包括本地 sentence-transformers、OpenAI 兼容端点、Google Gemini 和 MiniMax。本地嵌入使用 `CRG_EMBEDDING_MODEL`；OpenAI 兼容提供者使用 `CRG_OPENAI_BASE_URL`、`CRG_OPENAI_API_KEY` 和 `CRG_OPENAI_MODEL`。云提供者需显式启用，除非设置 `CRG_ACCEPT_CLOUD_EMBEDDINGS=1`，否则会打印出站警告。

### 7. 带风险评分的变更检测（v2）
```
向你的 MCP 客户端提问："Review my recent changes with risk scoring"
```
使用 `detect_changes_tool` 将 diff 映射到受影响的函数、流、社区和测试缺口。

### 8. 探索架构（v2）
```
向你的 MCP 客户端提问："Show me the architecture of this project"
```
使用 `get_architecture_overview_tool` 获取基于社区的架构图，含耦合警告。

### 9. 生成 Wiki（v2）
```bash
code-review-graph wiki
```
在 `.code-review-graph/wiki/` 中为每个检测到的社区创建 Markdown Wiki 页面。

### 10. 多仓库搜索（v2）
```bash
code-review-graph register /path/to/other/repo --alias mylib
```
然后使用 `cross_repo_search_tool` 跨所有注册的仓库搜索。

## Token 节省

CRG 通过发送图谱推导的结构化上下文而非广泛的文件转储来减少审查上下文。确切节省量取决于仓库和变更形态。评估运行器报告 README 中使用的当前基准数据：

```bash
code-review-graph eval --all
```

自 v2.3.4 起，审查和影响工具包含精简的 `context_savings` 元数据。v2.3.5 中 CLI 在 `detect-changes --brief` 和 `update --brief` 上展示一个带框的 `Token Savings` 面板，含按类别细目（函数 / 测试 / 风险 / 其他），总和精确等于图谱响应大小。添加 `--verify` 可与 OpenAI 的 `cl100k_base` 分词器交叉核对（需要 `pip install tiktoken`）。所有数字均标注为预估，因为使用保守近似而非特定模型的分词；校准显示预估在总量上与真实 GPT-4 Token 偏差约 ~1%。小型单文件变更偶尔可能比原始文件使用更多上下文，因为图谱元数据有开销。

## 支持的语言

解析器目前覆盖 Python、JavaScript、TypeScript/TSX、Go、Rust、Java、C/C++、C#、Ruby、Kotlin、Swift、PHP、Scala、Solidity、Dart、R、Perl、Lua/Luau、Objective-C、Shell 脚本、Elixir、Zig、PowerShell、Julia、ReScript、GDScript、Nix、Verilog/SystemVerilog、SQL、Vue/Svelte 单文件组件、通过 TypeScript 解析器解析的 Astro 文件、Jupyter/Databricks 笔记本（`.ipynb`）和 Perl XS 文件（`.xs`）。

无扩展名的脚本通过 shebang 检测，覆盖常见的 bash/sh/zsh/ksh/dash/ash、Python、Node、Ruby、Perl、Lua、Rscript 和 PHP 解释器。

尚未覆盖的语言可以通过 `.code-review-graph/languages.toml` 配置添加，无需 fork——参见 [CUSTOM_LANGUAGES.md](CUSTOM_LANGUAGES.md)。

## 索引内容

- **节点**：Files、Classes、Functions/Methods、Types、Tests
- **边**：CALLS、IMPORTS_FROM、INHERITS、IMPLEMENTS、CONTAINS、TESTED_BY、DEPENDS_ON

详见 [schema.md](schema.md)。

## 忽略模式

默认情况下，以下路径被排除在索引之外：

```
.code-review-graph/**    node_modules/**    .git/**
__pycache__/**           *.pyc              .venv/**
venv/**                  dist/**            build/**
.next/**                 target/**          *.min.js
*.min.css                *.map              *.lock
package-lock.json        yarn.lock          *.db
*.sqlite                 *.db-journal
```

要添加自定义模式，在仓库根目录创建 `.code-review-graphignore` 文件（语法与 `.gitignore` 相同）：

```
generated/**
vendor/**
*.generated.ts
```

在 git 仓库中，索引基于被跟踪文件（`git ls-files`），因此 gitignored 文件会自动跳过。使用 `.code-review-graphignore` 来排除被跟踪的文件或在没有 git 时使用。
