# 故障排查

## 安装/设置常见问题快速参考

四个问题占了大半支持请求。先检查这些：

### 1. `.claude/settings.json` 中出现 `Hooks use a matcher + hooks array` 错误

**你使用的是 v2.2.3 之前的版本。** v2.2.1 和 v2.2.2 发布了损坏的钩子 schema——扁平的 `{matcher, command, timeout}` 条目，没有所需的嵌套 `hooks: []` 数组，超时以毫秒而非秒为单位，以及一个不是真正 Claude Code 事件的 `PreCommit` 事件。PR #208（v2.2.3 发布）重写了生成器以输出正确的 v1.x+ schema。

**修复：**

```bash
pip install --upgrade code-review-graph   # → v2.2.4 或更高
cd /path/to/your/project
code-review-graph install                 # 重写 .claude/settings.json
```

重新安装会合并替换整个损坏的 `hooks` 块为新的嵌套格式，并在通过 `git rev-parse --git-path hooks` 解析的钩子目录中放置一个真正的 git pre-commit 钩子——通常是 `.git/hooks/pre-commit`，但链接的 worktree 和 `core.hooksPath`（husky）配置也能处理。v2.2.3+ 中 "提交前检查" 存在于那里，而非 Claude Code 设置中。

有效的 Claude Code 钩子事件有：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`SubagentStop`、`SessionStart`、`SessionEnd`、`PreCompact`、`Notification`。没有 `PreCommit`。

### 2. `pip install` 后出现 `code-review-graph: command not found`

`pip install` 将控制台脚本放在不在你 `$PATH` 上的 `bin/` 目录中。四个修复方法，按推荐顺序：

**选项 1 — 使用 `pipx`（最干净）：**

```bash
pip uninstall code-review-graph
pipx install code-review-graph
```

`pipx` 在隔离的 venv 中安装 CLI 工具。如果之后还找不到命令，运行 `pipx ensurepath` 或将 `~/.local/bin` 添加到你的 PATH。

**选项 2 — 使用 `uvx`（无需安装）：**

```bash
uvx code-review-graph install
uvx code-review-graph build
```

**选项 3 — 作为 Python 模块运行（始终有效）：**

```bash
python -m code_review_graph install
python -m code_review_graph build
```

**选项 4 — 手动修复 PATH：**

```bash
pip show code-review-graph | grep Location
# 找到相邻的 `bin/` 目录；macOS 用户安装通常是
# ~/Library/Python/3.X/bin。添加到你的 shell rc：
echo 'export PATH="$HOME/Library/Python/3.12/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 3. code-review-graph 是项目范围还是用户范围？

**两者都是**——四个不同的部分，各有不同的范围：

| 部分 | 范围 | 位置 |
|------|------|------|
| Python 包 | 用户范围 | 通过 `pip`/`pipx`/`uvx` 安装一次 |
| 图谱数据库 | 项目范围 | 每个项目内的 `.code-review-graph/graph.db` |
| MCP 服务器配置 (`.mcp.json`) | 项目范围 | Claude Code 每项目启动一个 MCP 服务器，`cwd=<project>` |
| 多仓库注册表 | 用户范围 | `~/.code-review-graph/registry.json`（仅用于 `cross_repo_search`） |

**简而言之**：安装工具**一次**，然后在**每个**你要图谱感知审查的项目中运行 `code-review-graph install && code-review-graph build`。

### 4. 使用 venv？你必须手动更新 `settings.json`

Claude Code 钩子和 `.claude/settings.json` 中的 MCP 工具路径在**安装时硬编码**。如果你在运行 `code-review-graph install` 后切换到（或创建）虚拟环境，路径仍然指向旧的解释器，服务器会静默失败或使用错误的 Python。

**修复 — 更新 `.mcp.json` 中的 `command`/`args` 和 `.claude/settings.json` 中的任何钩子命令以匹配你的 venv：**

```json
// .mcp.json — 指向你的 venv 的 Python 或 venv 中的 uvx
{
  "mcpServers": {
    "code-review-graph": {
      "command": "/path/to/your/venv/bin/uvx",
      "args": ["code-review-graph", "serve"]
    }
  }
}
```

或者直接从激活的 venv 中重新运行 `code-review-graph install`，这样路径会正确重新生成：

```bash
source .venv/bin/activate          # 先激活你的 venv
code-review-graph install          # 重写 .mcp.json 和钩子路径
```

然后完全退出并重新打开 Claude Code，让它获取新配置。

### 5. "我构建了图谱但 Claude Code 在新会话中看不到"

最可能的原因，按排名：

1. **你没在 `install` 后重启 Claude Code。** Claude Code 在启动时读取 `.mcp.json`——如果你在一个会话中运行了 `install`，完全退出并重新打开 Claude Code 才能注册 MCP 服务器。
2. **新会话的 `cwd` 是不同目录。** MCP 服务器以 `cwd=<project>` 启动并从那里读取 `.code-review-graph/graph.db`。如果新会话在父文件夹或不同项目中打开，它找不到你构建的图谱。
3. **你运行了 `build` 但没运行 `install`。** `build` 创建 `graph.db`；`install` 是通过 `.mcp.json` 将 MCP 服务器注册到 Claude Code 的命令。两者都需要。
4. **MCP 服务器启动时崩溃。** 在 Claude Code 中运行 `/mcp` 查看服务器状态，或在 macOS 上检查 `~/Library/Logs/Claude/mcp*.log`。

**快速检查清单：**

```bash
cd /path/to/your/project
code-review-graph status    # 应该打印已构建图谱的 Files/Nodes/Edges
ls .mcp.json                # 应该存在
cat .mcp.json               # 应该引用 `code-review-graph serve`
# 然后：完全退出 Claude Code 并在此项目中重新打开
```

如果 `status` 显示图谱存在但新会话中 `/mcp` 没有列出 `code-review-graph`，`.mcp.json` 不在会话的 `cwd` 中——从正确的项目根目录重新运行 `code-review-graph install`。

---

## 数据库锁错误
图谱使用带 WAL 模式的 SQLite。如果你看到锁错误：
- 确保同时只有一个构建进程运行
- 数据库会自动恢复；重试即可
- 如果损坏，删除 `.code-review-graph/graph.db-wal` 和 `.code-review-graph/graph.db-shm`

## 大型仓库（>10k 文件）
- 首次构建可能需要 30-60 秒
- 后续增量更新很快（<2s）
- 向 `.code-review-graphignore` 添加更多忽略模式：
  ```
  generated/**
  vendor/**
  *.min.js
  ```

## 构建后节点缺失
- 检查文件语言是否受支持（见 [FEATURES.md](FEATURES.md)）
- 检查文件是否被忽略模式匹配
- 使用 `full_rebuild=True` 强制完全重新解析

## 图谱似乎过期
- 钩子在编辑/提交时自动更新
- 如果过期，手动运行 `/code-review-graph:build-graph`
- 检查 `.claude/settings.json` 中是否配置了钩子（重新运行 `code-review-graph install` 以重新生成）

## 嵌入不工作
- 安装：`pip install code-review-graph[embeddings]`
- 运行 `embed_graph_tool` 计算向量
- 首次嵌入运行下载模型（~90MB，一次性）

## MCP 服务器无法启动
- 验证 `uv` 已安装（`uv --version`；通过 `pip install uv` 或 `brew install uv` 安装）
- 检查 `uvx code-review-graph serve` 运行无错
- 如果使用自定义 `.mcp.json`，确保使用 `"command": "uvx"` 和 `"args": ["code-review-graph", "serve"]`
- 重新运行 `code-review-graph install` 以重新生成配置

## Windows / WSL

- 升级到 v2.3.6+，如果 `daemon status` 因 WinError 87 崩溃（#511）或 CLI `detect-changes` 在 Windows 上映射 0 个函数（#528）——两者均已修复
- 向 MCP 工具传递 `repo_root` 时路径使用正斜杠
- 在 WSL 中，确保 `uv` 安装在 WSL 内部（不是 Windows 版本）：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- 如果安装后找不到 `uv`，将 `~/.cargo/bin` 添加到你的 PATH
- 文件监视（`code-review-graph watch`）在 WSL1 上可能因文件系统事件限制有延迟；推荐 WSL2
- 在 Windows 原生（非 WSL）上，可能需要启用长路径支持：`git config --system core.longpaths true`

## 社区检测需要 igraph

- 安装：`pip install code-review-graph[communities]`
- 没有 igraph，社区检测回退到基于文件的分组（精度较低但可用）

## 带 LLM 摘要的 Wiki 生成

- 安装：`pip install code-review-graph[wiki]`
- 需要运行中的 Ollama 实例用于 LLM 驱动的摘要
- 没有 Ollama，Wiki 页面仅包含结构信息（无散文摘要）

## 可选依赖组

如果工具返回 ImportError，安装相关可选组：
- `pip install code-review-graph[embeddings]` 用于语义搜索
- `pip install code-review-graph[google-embeddings]` 用于 Google Gemini 嵌入
- OpenAI 兼容和 MiniMax 嵌入使用标准库 HTTP 客户端，只需其环境变量
- `pip install code-review-graph[communities]` 用于 igraph 社区检测
- `pip install code-review-graph[enrichment]` 用于通过 Jedi 的 Python 调用解析富化
- `pip install code-review-graph[eval]` 用于评估基准（matplotlib）
- `pip install code-review-graph[wiki]` 用于 Wiki LLM 摘要（ollama）
- `pip install code-review-graph[all]` 获取所有功能
