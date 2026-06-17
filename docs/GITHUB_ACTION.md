# GitHub Action：风险评分 PR 审查

code-review-graph 提供一个复合 GitHub Action（仓库根目录的 `action.yml`），在每个拉取请求上发布风险评分的图谱感知审查评论——可以把它看作一个托管的 AI 审查机器人（Greptile 风格），但分析是**本地优先**的：知识图谱完全在你的 CI 运行器上构建和查询，不向任何外部服务发送源代码。

每个 PR 运行时，该操作会：

1. 从 PyPI 安装 `code-review-graph`。
2. 恢复缓存的 `.code-review-graph/` SQLite 图谱（或在缓存未命中时从头构建），并增量重新解析 PR 变更的文件。
3. 运行 `code-review-graph detect-changes --base origin/<base-branch>` 获取风险评分的函数、受影响的执行流和测试缺口。
4. 通过 `scripts/render_pr_comment.py` 渲染 Markdown 报告，并更新一个置顶 PR 评论——每次推送时同一评论被更新，因此 PR 线程从不被刷屏。
5. 可选：当整体风险分数超过阈值时使作业失败（`fail-on-risk`）。

## 快速开始（外部仓库）

```yaml
# .github/workflows/code-review-graph.yml
name: code-review-graph

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: tirth8205/code-review-graph@v2.3.6
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

这就是全部设置。Actions 提供的默认 `GITHUB_TOKEN` 就够了——不需要 PAT、API 密钥或第三方服务。

将审查变为合并门控：

```yaml
      - uses: tirth8205/code-review-graph@v2.3.6
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          fail-on-risk: high
```

## 输入参数

| 输入 | 必需 | 默认值 | 描述 |
|------|------|--------|------|
| `github-token` | 是 | — | 通过 GitHub API 发布置顶 PR 评论所用的 Token。作业的默认 `GITHUB_TOKEN` 在 `pull-requests: write` 权限时即可工作。 |
| `comment` | 否 | `true` | 发布（并持续更新）置顶 PR 评论。设为 `false` 仅运行分析/门控而不评论。 |
| `fail-on-risk` | 否 | `none` | 当整体风险分数达到某级别时使作业失败：`none`（从不失败）、`high`（风险 ≥ 0.70）、`critical`（风险 ≥ 0.85）。 |
| `python-version` | 否 | `3.12` | 运行 code-review-graph 的 Python 版本（支持 3.10+）。 |

### 风险等级

`detect-changes` 产生一个 0.0–1.0 的整体风险分数（变更函数中的最大值；评分因素见 `code_review_graph/changes.py:compute_risk_score`：流参与度、社区交叉、测试覆盖、安全敏感名称、调用者计数）。Action 将其映射到等级：

| 等级 | 分数 |
|------|------|
| low（低） | < 0.40 |
| medium（中） | 0.40 – 0.69 |
| high（高） | 0.70 – 0.84 |
| critical（严重） | ≥ 0.85 |

## 评论包含的内容

- **整体风险**分数和等级，含变更函数、受影响流和测试缺口的计数。
- **风险评分变更**——按风险排序的顶级变更符号表，含 file:line 位置和测试覆盖状态。
- **受影响的执行流**——变更触及的入口点流，按关键性排序。
- **测试缺口**——没有直接测试覆盖的变更函数。
- **Token 节省**——图谱支撑的报告比完整读取每个变更文件节省了多少 Token。与 CLI 的 Token Savings 面板显示的 `context_savings` 估算相同（`chars / 4` 近似值，标注 `estimated: true`——见 [REPRODUCING.md](REPRODUCING.md) 了解校准方法论）。
- `Powered by code-review-graph` 页脚。

评论以一个隐藏的 HTML 标记（`<!-- code-review-graph-report -->`）开头。Action 每次运行时通过 `gh api` 查找标记并 PATCH 现有评论而非创建新的（"置顶"评论）。

## 缓存行为

Action 使用 `actions/cache` 缓存 `.code-review-graph/` 目录（SQLite 图谱数据库）：

- **键**：`code-review-graph-schema9-<runner.os>-<hashFiles(lockfiles)>`，其中 lockfile 哈希覆盖常见的 Python/JS/Go/Rust/Ruby/PHP lockfile（`uv.lock`、`poetry.lock`、`requirements*.txt`、`package-lock.json`、`go.sum`、`Cargo.lock` 等）。
- **模式段**：`schema9` 追踪数据库模式版本（`code_review_graph/migrations.py` 中的 `LATEST_VERSION`）。当模式变更时会增加，因此不会跨不兼容版本恢复过期缓存。
- **恢复键**：回退到相同 OS 和模式的任何缓存，因此 lockfile 变更仍可复用之前的图谱。
- **缓存命中**：Action 运行 `code-review-graph update --base origin/<base-branch>`，只重新解析与 PR 基准引用不同的文件。如果恢复的数据库不可用，则回退到完整 `build`。
- **缓存未命中**：运行完整 `code-review-graph build`（一次性成本；后续 PR 运行为增量）。

## 安全说明

- **Token 范围**：Action 只需 `pull-requests: write`（发布评论）和 `contents: read`（checkout）。在 workflow 的 `permissions:` 块中仅授予这些——上面的示例已做到。Token 仅用于列出/创建/更新那一个 PR 评论。
- **本地优先**：分析完全在运行器上运行。没有代码、diff 或元数据离开 GitHub 基础设施；没有外部 API、账户或密钥。
- **不可信输入**：所有动态值（`github.base_ref`、PR 编号、Action 输入）通过环境变量传递给脚本，从不插入 shell 命令。Markdown 渲染器在表/标记字符到达评论正文前进行转义，并从符号名和文件路径中剥离控制字符，此外还有服务器端 `_sanitize_name()` 的清理。
- **版本固定**：从其他仓库使用 Action 时，将 `uses:` 固定到 release 标签或 commit SHA 而非 `@main`。
- **Fork PR**：来自 fork 的 `pull_request` 运行会收到只读的 `GITHUB_TOKEN`，因此评论步骤对 fork PR 会失败，除非你使用 `pull_request_target`——这会检出可信的基准分支工作流代码；切换前请理解[安全影响](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)，或为 fork PR 设置 `comment: false`。

## 自行验证

本仓库通过 [`.github/workflows/pr-review.yml`](../.github/workflows/pr-review.yml) 在自己的 PR 上运行此 Action，使用的 `uses: ./`（本地 `action.yml`）。

## 渲染脚本

Markdown 渲染和风险门控逻辑位于 [`scripts/render_pr_comment.py`](../scripts/render_pr_comment.py)（仅使用标准库，单元测试在 `tests/test_action_render.py` 中），而非内联 YAML，因此可以测试和复用：

```bash
code-review-graph detect-changes --base origin/main | \
  python scripts/render_pr_comment.py            # Markdown 到标准输出

python scripts/render_pr_comment.py --input report.json \
  --fail-on-risk high --quiet                    # 仅门控：违约时退出码 3
```
