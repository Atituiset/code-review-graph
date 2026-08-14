# 快速上手

本篇目标：从安装到让 AI 助手用上知识图谱，跑通最小闭环。所有命令都已在源码中核实，子命令定义见 `code_review_graph/cli.py:613-1233`。

## 1. 安装

项目要求 Python 3.10+。用 pip 或 uv 安装（uv 是 Astral 出品的快速 Python 包管理器，装了它之后 MCP 配置会优先走 `uvx`，启动更快）：

```bash
pip install code-review-graph
# 或者
uv tool install code-review-graph
```

安装后会得到两个命令行程序（入口定义见 `pyproject.toml:48-50`）：

- `code-review-graph`：主 CLI，建图、查询、审查、启动 MCP server 都靠它；
- `crg-daemon`：多仓库监听守护进程（daemon，指在后台长期运行的程序），用于同时监听多个仓库的文件变化。

验证安装：

```bash
code-review-graph --version
```

## 2. 建图：build

进入你的代码仓库目录，执行全量建图：

```bash
cd /path/to/your/repo
code-review-graph build
```

`build` 会用 tree-sitter 重新解析所有文件，把符号和关系写入 `<repo>/.code-review-graph/graph.db`（见 `code_review_graph/cli.py:736`）。常用参数：

- `--repo PATH`：显式指定仓库根目录，不指定则自动探测；
- `-q / --quiet`：静默模式，适合 CI；
- `--skip-flows`：跳过执行流和社区检测，只保留符号与全文索引，建图更快；
- `--data-dir PATH`：把图数据库放到仓库外部目录（适合网络共享盘等特殊场景）。

建完后可以随时看图的健康状况：

```bash
code-review-graph status
```

`status` 会输出节点数、边数、流数、社区数等统计信息（`code_review_graph/cli.py:851`）。

## 3. 增量更新：update

全量建图只需一次。之后代码有变动，用增量更新，只重新解析变化的文件：

```bash
code-review-graph update
```

默认以"图上次构建时对应的提交"为基准做 git diff；也可以用 `--base HEAD~3` 之类显式指定基准（`code_review_graph/cli.py:757`）。两个实用变体：

```bash
code-review-graph update --brief    # 更新图谱，并顺带打印本次改动的风险摘要与 token 节省面板
code-review-graph detect-changes --brief  # 图已经是最新时，只做分析不重新解析
```

注意区分：`update --brief` 会重新解析改动文件并更新图；`detect-changes` 是只读分析，不改动图（`code_review_graph/cli.py:982`）。

## 4. 文件监听：watch 与 daemon

如果你希望"改完文件图自动就是新的"，有两种方式：

```bash
code-review-graph watch          # 前台监听当前仓库，文件变化时自动增量更新
crg-daemon start                 # 后台守护进程，可同时监听多个仓库
crg-daemon status                # 查看守护进程状态
crg-daemon stop                  # 停止
```

`watch`（`code_review_graph/cli.py:841`）适合自己开着终端干活的场景；`crg-daemon` 适合长期托管多个仓库。另外，`serve --auto-watch` 可以在 MCP server 运行的同时开一个监听线程，一行命令解决"接入 AI + 图保持新鲜"两件事（`code_review_graph/cli.py:1155`）。

## 5. 接入 AI 工具：install 一键配置

大多数情况下不需要手写 MCP 配置。运行：

```bash
code-review-graph install
```

它会自动检测你机器上装了哪些 AI 编码工具（Claude Code、Cursor、Windsurf、Zed、Continue、OpenCode、Gemini CLI、Copilot 等，完整清单见 `code_review_graph/cli.py:55-59` 的 `_PLATFORM_CHOICES`），并为每个工具写好正确的 MCP 配置、安装平台原生的 hooks 和技能文件、往 CLAUDE.md / AGENTS.md 里注入图使用指引。装完**重启你的编辑器或 AI 工具**生效。

常用参数（`code_review_graph/cli.py:613-652`）：

```bash
code-review-graph install --dry-run            # 只看会做什么，不写任何文件
code-review-graph install --platform cursor    # 只配置 Cursor
code-review-graph install --platform claude-code
code-review-graph install -y                   # 跳过交互确认
code-review-graph install --no-hooks           # 不装 hooks
code-review-graph install --no-instructions    # 不改 CLAUDE.md / AGENTS.md
```

如果想手动启动 server（比如调试），可以用：

```bash
code-review-graph serve                # 通过 stdio 提供 MCP 服务（默认）
code-review-graph serve --http         # 在本机 5555 端口提供 HTTP MCP
```

`mcp` 是 `serve` 的别名，两者等价（`code_review_graph/cli.py:1193`）。

## 6. 最常用的五个 MCP 工具

配置完成后，AI 助手就可以调用图谱工具了。先记住这五个，覆盖八成场景：

- `detect_changes_tool`：审查代码改动时第一个用。基于 git diff 找出改动的函数，给出每个函数的风险评分、受影响的流和测试缺口（`code_review_graph/main.py:633`）。
- `get_review_context_tool`：需要看改动相关源码时用。把改动涉及的代码片段按 token 预算裁剪后返回，而不是整文件倾倒（`code_review_graph/main.py:289`）。
- `get_impact_radius_tool`：想知道"改了这个会波及谁"时用。沿调用、继承等边向外扩散，算出影响面（blast radius）。
- `query_graph_tool`：精确查某一种关系时用。比如 `callers_of`（谁调用了它）、`tests_for`（它的测试在哪）、`callees_of`（它调用了谁）等模式（`code_review_graph/main.py:247`）。
- `semantic_search_nodes_tool`：只记得大概意思、不记得确切名字时用。按名字、关键词或语义相似度找函数/类（`code_review_graph/main.py:322`）。

你不需要手敲这些工具名——直接用自然语言向 AI 提需求（"帮我审查这次改动"），AI 会自己选择合适的工具调用。下一篇 [核心概念](./concepts.md) 解释图、流、社区这些工具背后的数据结构。

## 7. 可选功能：按需安装 extras

基础安装已经够建图、审查、查关系。以下能力以可选依赖（extras，pip 的"按需加装"机制）提供（见 `README.md:526-532`）：

```bash
pip install "code-review-graph[embeddings]"    # 本地向量 embedding，用于语义搜索
pip install "code-review-graph[communities]"   # 社区检测（igraph，Leiden 算法）
pip install "code-review-graph[enrichment]"    # Python 调用解析增强（Jedi）
pip install "code-review-graph[all]"           # 全部可选依赖
```

两个常见搭配：

- 装了 `embeddings` 后运行 `code-review-graph embed`，`semantic_search_nodes_tool` 就能按"意思相近"搜索，而不只是关键词匹配；
- 不装 `communities` 也能用社区功能，只是退化为按文件目录分组，精度略低（`code_review_graph/communities.py:1-4`）。

## 8. 其他常用子命令速查

都支持 `--repo PATH` 指定仓库，定义集中在 `code_review_graph/cli.py:613-1233`：

```bash
code-review-graph flows --sort criticality      # 按关键性列出执行流
code-review-graph communities --sort size       # 列出社区
code-review-graph architecture                  # 架构总览
code-review-graph query callers_of <符号名>     # 查关系（谁调用了它）
code-review-graph search "login" --kind Function
code-review-graph dead-code                     # 找没人调用也没测试的函数
code-review-graph visualize --serve             # 生成交互式 HTML 图并本地预览
code-review-graph forget <路径>                  # 把某些文件从图里移除（不重建）
code-review-graph uninstall --dry-run           # 卸载前先看会清理什么
```

## 9. 常见问题

**图数据会被提交进 git 吗？** 不会。建图时会自动把 `.code-review-graph/` 追加到仓库的 `.gitignore`（见 `code_review_graph/incremental.py:408-425`）。

**想排除某些文件不进图？** 在仓库根目录建一个 `.code-review-graphignore` 文件，写法与 `.gitignore` 相同（`code_review_graph/incremental.py:435`）。

**MCP server 想只暴露部分工具？** `code-review-graph serve --tools query_graph_tool,semantic_search_nodes_tool` 可以按逗号清单裁剪，也可用环境变量 `CRG_TOOLS`（`code_review_graph/cli.py:1166-1173`）。

**配置装错了想重来？** `code-review-graph uninstall` 会清理图数据、MCP 注册、hooks 和生成的技能文件；先 `--dry-run` 预览，确认无误后加 `-y` 执行（`code_review_graph/cli.py:692`）。
