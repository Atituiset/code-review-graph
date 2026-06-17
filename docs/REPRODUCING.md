# 复现基准测试

本文档提供复现 README 和 `diagrams/` 中展示的每个基准数字的精确命令。两个不同日子在不同机器上运行以下步骤的人应该产生相同的数字（在浮点舍入范围内）。

如果你得到不同的数字，那是 bug——请提交 issue。

## 验证 "节省 Token" 数字

CLI 的 `Token Savings` 面板使用 `chars / 4` 近似值并标注 `estimated: true`，而非特定模型的分词器。该近似值设计为既快（无需模型加载、无需推理）又保守。

### 如何对照真实分词器验证

```bash
pip install tiktoken
code-review-graph detect-changes --brief --verify
```

面板会增加一行 `Verified (tiktoken)`，显示用 OpenAI 的 `cl100k_base` 分词器（GPT-4 系列）做的相同计算。如果预估明显偏差，你会立即看到：

```text
┌───────────────────────── Token Savings ─────────────────────────┐
│ 完整上下文将是:         12,921 Token                             │
│ 图谱上下文使用:            762 Token                             │
│ 节省:                    12,159 Token (~94%)                    │
│ 已验证 (tiktoken):      10,835 Token (~93%)  [11,611 → 776]    │
│ 细目: 函数 244 · 测试 191 · 风险 244 · 其他 83                  │
└─────────────────────────────────────────────────────────────────┘
```

### 校准结果（已提交）

对来自 6 个测试仓库的 222 个文件 / 2.2 MB 多语言源码（Python、JS、TS、Go、Rust、RST、MD）的一次性校准：

| 仓库 | 样本文件 | 字节数 | chars/4 预估 | tiktoken 实际 | 比率 预估/实际 |
|---|---:|---:|---:|---:|---:|
| flask | 46 | 470,179 | 117,559 | 109,969 | 1.069 |
| fastapi | 38 | 156,224 | 39,072 | 34,897 | 1.120 |
| gin | 30 | 471,793 | 117,962 | 132,296 | 0.892 |
| express | 23 | 296,805 | 74,207 | 83,575 | 0.888 |
| httpx | 38 | 254,184 | 63,556 | 62,909 | 1.010 |
| code-review-graph | 47 | 539,206 | 134,820 | 120,760 | 1.116 |
| **总计** | **222** | **2,188,391** | **547,176** | **544,406** | **1.005** |

`chars / 4` 在总量上与真实 GPT-4 Token 偏差 **+0.5%**。按仓库它在 **-11%**（gin：大量短的 Go 标识符）和 **+12%**（fastapi：大量文档字符串和类型提示）之间波动，但**比率**会稳定，因为除法两侧有相同偏差。

使用此提交中 `code_review_graph/context_savings.py:verify_with_tiktoken` 的片段复现校准，或在任意提交上运行 `--verify` 标志。

## 什么是和什么不是确定性的

| 可复现 | 原因 |
|---|---|
| Tree-sitter 解析 | 输入字节的纯函数 |
| 节点/边计数 | 以 `qualified_name` 为键的确定性 upsert |
| FTS5 BM25 分数 | 确定性 |
| 通过 CPU 上 `all-MiniLM-L6-v2` 的嵌入 | 模型权重由 HuggingFace 缓存中的 SHA 缓存固定 |
| Leiden 社区 ID | 已播种 — `communities.py` 中 `_LEIDEN_SEED=42`，通过 `CRG_LEIDEN_SEED` 环境变量覆盖 |
| `naive_corpus_tokens` | 对固定 git checkout 是确定性的 |
| 固定 SHA 处的 `git clone` | 确定源真实字节流 |

曾经使其**不**可复现的问题（现均已修复）：

- `code_review_graph/eval/configs/*.yaml` 中的 `commit: HEAD` — 已替换为每个仓库固定的最新测试提交 SHA
- `git clone --depth 50` 在固定 SHA 超出浅层窗口时静默回退到错误提交 — 现在使用完整克隆并显式 `returncode` 检查
- Leiden 使用未播种的 RNG 运行 — 现已播种
- `nextjs.yaml` 是一个错误命名的评估本仓库的配置 — 已重命名为 `code-review-graph.yaml`
- FTS5 被创建但评估框架的 `full_build` 调用从未填充 — `code_review_graph/eval/runner.py` 现在直接调用 `postprocessing.run_post_processing`

## 前提条件

- Python 3.10 或更新版本
- PATH 上有 `git`
- 网络访问（克隆 6 个上游仓库约 600 MB）
- 约 3 GB 可用磁盘
- 嵌入步骤：`torch` + `sentence-transformers` 约需额外 700 MB

## 步骤 1 — 安装正确的附加组件

```bash
git clone https://github.com/tirth8205/code-review-graph
cd code-review-graph

# eval 附加：pyyaml + matplotlib（matplotlib 仅 `--report` 需要）
# embeddings 附加：sentence-transformers + numpy
uv sync --extra eval --extra embeddings     # 或：pip install -e ".[eval,embeddings]"
```

## 步骤 2 — 运行正式评估

此步骤在固定 SHA 克隆 6 个上游仓库，为每个仓库构建完整图谱（解析器 + 跨文件解析器 + 签名 + FTS5 + 流 + Leiden 社区），然后运行 `token_efficiency`、`impact_accuracy`、`agent_baseline` 和 `multi_hop_retrieval` 基准。

```bash
uv run code-review-graph eval \
  --benchmark token_efficiency,impact_accuracy,agent_baseline,multi_hop_retrieval
```

失败语义（适用于每个基准）：抛出的工具调用**不是**测量值。该行保留在 CSV 中，`status=error` 用于取证，但排除在每个聚合之外。（两个历史 bug 使失败看起来像胜利：抛出的 `get_review_context` 产生 `graph_tokens=0` 和 `naive/1` 的比率，抛出的 `analyze_changes` 静默设置 `predicted = changed`，保证召回率 1.0。两者均已修复；回归测试在 `tests/test_eval.py` 中。）

M1/M2 Mac 上的预期运行时间：构建阶段约 8-15 分钟，每个基准几秒。

输出：

- `evaluate/test_repos/{express,fastapi,flask,gin,httpx,code-review-graph}/`
- `evaluate/test_repos/<name>/.code-review-graph/graph.db`
- `evaluate/results/<name>_<benchmark>_<date>.csv`

## 步骤 3 — 生成嵌入（独立基准所需）

独立 Token 基准附带 5 个硬编码的自然语言问题。没有嵌入，混合搜索无法匹配它们，基准静默返回 0× 缩减比率（会打印醒目警告）。

```bash
for repo in express fastapi flask gin httpx code-review-graph; do
  uv run code-review-graph embed --repo "evaluate/test_repos/$repo"
done
```

预期运行时间：总计 2-5 分钟。向量存储在同一个 `graph.db` 中。

## 步骤 4 — 运行独立 Token 基准

此基准比较仓库中的**所有源文件 Token**与每个样本问题的**5 个搜索结果 + 少量邻居边**。比率回答：*图谱让我在典型问题上跳过多少 Token？*

```bash
uv run python <<'PY'
import json
from pathlib import Path
from code_review_graph.graph import GraphStore
from code_review_graph.token_benchmark import run_token_benchmark

results = {}
for repo in sorted(Path("evaluate/test_repos").iterdir()):
    db = repo / ".code-review-graph" / "graph.db"
    if not db.exists():
        continue
    store = GraphStore(str(db))
    try:
        results[repo.name] = run_token_benchmark(store, repo)
    finally:
        store.close()

print(f"{'仓库':<22}{'naive_tokens':>16}{'avg_graph_tokens':>20}{'avg_ratio':>14}")
print("-" * 72)
for name, out in sorted(results.items(), key=lambda x: -x[1]["average_reduction_ratio"]):
    pq = out["per_question"]
    avg_graph = int(sum(r["graph_tokens"] for r in pq) / max(len(pq), 1))
    print(f"{name:<22}{out['naive_corpus_tokens']:>16,}"
          f"{avg_graph:>20,}{out['average_reduction_ratio']:>13.1f}×")

Path("evaluate/standalone_token_benchmark.json").write_text(json.dumps(results, indent=2))
PY
```

## 标准数字

<!-- BEGIN canonical-stats -->
采集于 **2026-05-25**，macOS arm64，Python 3.11，sentence-transformers 5.5.1，
`all-MiniLM-L6-v2`，`CRG_LEIDEN_SEED=42`。如果你的数字与四舍五入偏差较大，链中某处有漂移——请提交 issue。

### 独立 Token 基准（`code_review_graph/token_benchmark.py`）

每行是 5 个样本问题（`how does authentication work`、`what is the main entry point`、`how are database connections managed`、`what error handling patterns are used`、`how do tests verify core functionality`）的平均值。

| 仓库 | 快照 SHA | naive_corpus_tokens | avg graph_tokens | avg ratio |
|---|---|---:|---:|---:|
| fastapi | `0227991a` | 951,071 | 2,169 | **528.4×** |
| code-review-graph | `84bde354` | 208,821 | 2,495 | **93.0×** |
| gin | `5c00df8a` | 166,868 | 1,990 | **91.8×** |
| flask | `a29f88ce` | 125,022 | 1,986 | **71.4×** |
| express | `b4ab7d65` | 135,955 | 3,465 | **40.6×** |
| httpx | `b55d4635` | 89,492 | 2,438 | **38.0×** |

6 个仓库范围：**38× – 528×**。数字比之前捕获下降，因为 (a) 测试仓库现在从零抹除/重新克隆——没有残留构建产物或本地缓存抬高 naive 基线；(b) 此版本每节点的嵌入文本变丰富了（见 `embeddings._node_to_text`），因此图谱响应本身略大。两者都是对先前数字的正确性改进。

### 正式 `token_efficiency` 基准（`code_review_graph/eval/benchmarks/token_efficiency.py`）

不同的分母：仅每个提交的**变更文件内容**与完整 `get_review_context()` JSON 对比。对于小提交，响应大于输入（它携带影响半径边 + 源片段），因此这里的比率故意 < 1.0——这不是 bug，它测量的与独立基准不同。

原始每提交 CSV 在 `evaluate/results/<repo>_token_efficiency_*.csv`。

### 影响准确性（`code_review_graph/eval/benchmarks/impact_accuracy.py`')

6 个仓库中的 13 个提交。基准并排生成两个真值模式，通过 `ground_truth_mode` CSV 列区分：

| 模式 | 真值 | 告诉你什么 |
|---|---|---|
| `graph-derived (circular — upper bound)` | 变更文件 + 有 CALLS/IMPORTS_FROM 边指向它们的文件——**从预测器遍历的相同图谱推导** | 上限。此处召回率 1.0 部分是构造上的真实，非独立证据。 |
| `co-change (same commit, seed excluded)` | 作者在同一提交中实际修改的*其他*文件，给定一个种子文件 | 来自 git 历史的近似独立证据。预期召回率显著较低。 |

下方标准数字是在**仅图谱推导模式**下捕获的（协同变更模式在捕获时不存在）。将召回率行视为循环上限，而非"100% 召回率"：

| 指标（图谱推导模式——循环上限） | 值 |
|---|---|
| 召回率（13 个提交平均） | **1.000**（每个提交的上限） |
| F1（平均） | **0.714** |
| F1（中位数） | 0.667 |
| F1（最小/最大） | 0.455 / 1.000 |

标准协同变更数字将在下次完整捕获后添加——我们不在测量前引用它们。在协同变更模式下单文件提交记录为 `status=skipped`（没有独立对照可供评分）。

影响半径分析在某些提交中过度预测（精度 ≈ 0.30 最差情况，34 个文件被标记为 10 文件变更）。这是有意的：遗漏依赖比多审查一个文件更糟。

### 多跳检索（`code_review_graph/eval/benchmarks/multi_hop_retrieval.py`)

6 个仓库中的 11 个手工策划任务。每个任务是 2 步工具链：

1. `hybrid_search(nl_query, limit=10)` 查找起始锚点节点。
2. `query_graph(<traversal_pattern>, target=<anchor>)` 沿 `callers_of` / `callees_of` / `tests_for` / `imports_of` 等走一跳。

任务仅当锚点在 top-K 中找到**且**遍历返回预期的邻居名称时**得分 1.0**。否则 **0.0**（将"搜索未找到锚点"和"遍历返回错误集"合为一体——在每任务 CSV 行的 `anchor_found` 和 `neighbor_recall` 中分开查看）。

| 仓库 | 任务 | 锚点找到 | 排名 | 邻居召回率 | 得分 |
|---|---|---|---:|---:|---:|
| code-review-graph | crg-parse-file-callers | 是 | 0 | 1.00 | **1.00** |
| code-review-graph | crg-upsert-node-callers | 是 | 4 | 1.00 | **1.00** |
| express | express-create-application-callees | 是 | 1 | 1.00 | **1.00** |
| fastapi | fastapi-route-handler-callers | 是 | 6 | 1.00 | **1.00** |
| fastapi | fastapi-get-dependant-callers | 否 | — | 0.00 | **0.00** |
| flask | flask-dispatch-callers | 是 | 3 | 1.00 | **1.00** |
| flask | flask-exception-callers | 是 | 5 | 1.00 | **1.00** |
| gin | gin-serve-http-callees | 是 | 5 | 1.00 | **1.00** |
| gin | gin-context-next-callers | 是 | 0 | 1.00 | **1.00** |
| httpx | httpx-client-request-callers | 是 | 0 | 1.00 | **1.00** |
| httpx | httpx-async-request-tests | 是 | 7 | 1.00 | **1.00** |

**11 个任务平均得分：0.909**。10/11 任务通过；剩下的一个失败（`fastapi-get-dependant-callers`）目标是拼作 `get_dependant`（"dependant" 带 `a`）的函数，而查询措辞为 "dependency declarations into a tree"——没有词汇重叠，也没有提升启发式可锁定的可提取标识符。留作诚实的失误；修复要么是查询改写，要么是更丰富的嵌入模型。

#### 得分如何从 0.545 提升到 0.909（同日修复）

v1 脚手架首次得分 **0.545**（6/11）。两个变更将其提升到 **0.909**（10/11），两者都是确定性、小型、在同一次会话中提交的：

1. **`embeddings.py:_node_to_text`** — 每节点的嵌入文本以前只是 `"{name} {kind} in {parent}"`。现在还包括点分形式（`APIRoute.get_route_handler`），分词器拆分标识符（`get route handler`）和封闭模块目录（`routing`、`fastapi`、`dependencies`）。所有重新嵌入是自动的——文本哈希变更，`EmbeddingStore.embed_nodes` 会重新嵌入。分词/分隔符规则见 `_split_identifier`。

2. **`search.py:extract_query_identifiers`** — 像 "Who advances the gin middleware chain via Context.Next" 这样的自然语言查询现在会提取其点分 / snake_case / CamelCase 标识符 Token。`qualified_name` 包含任何提取标识符的搜索结果获得 2.0× 提升。这将 `Context.Next` 从排名 11 推到排名 0。

剩余的 `fastapi-get-dependant-callers` 失败无法通过任一变更修复，因为查询与目标没有任何标识符或子串共享——那是启发式的边界。

此基准是 v1 脚手架（11 个任务）。意图是追踪**多跳工具链**作为代理实际使用模式而非单次检索。添加更多任务：向 `code_review_graph/eval/configs/*.yaml` 下的任何配置追加 `multi_hop_tasks:` 条目，schema 如下：

```yaml
multi_hop_tasks:
  - id: my-task-id                # 必需，唯一
    nl_query: "自然语言"          # 必需，代理会问什么
    anchor_qualified_suffix:     # 必需，预期的 qualified_name 的小写后缀
      "rel/path.py::owner.symbol" #   （不区分大小写的 endswith）
    traversal_pattern: callers_of # callers_of|callees_of|imports_of|
                                  # importers_of|tests_for|inheritors_of|children_of 之一
    expected_neighbor_names:      # 必需，应出现在遍历结果中的裸名列表
      - "expected_one"
    k: 10                         # 可选，搜索步骤的 top-K 深度
```

### 构建统计

| 仓库 | 节点 | 边 | 流 | 社区 | 嵌入 | FTS 索引行 |
|---|---:|---:|---:|---:|---:|---:|
| fastapi | 6,292 | 32,081 | 165 | 85 | 5,164 | 127 |
| express | 1,912 | 18,877 | 4 | 7 | 1,771 | 47 |
| gin | 1,589 | 17,237 | 114 | 41 | 1,491 | 29 |
| code-review-graph | 1,418 | 8,877 | 104 | 11 | 1,326 | 38 |
| flask | 1,415 | 8,259 | 78 | 13 | 1,329 | 35 |
| httpx | 1,261 | 8,228 | 128 | 5 | 1,193 | 34 |

嵌入计数低于节点计数因为 File 节点不被嵌入。FTS 索引行远低于节点数因为 FTS5 存储倒排索引段，而非每个索引文档一行。
<!-- END canonical-stats -->

## 代理基线基准（`code_review_graph/eval/benchmarks/agent_baseline.py`)

独立 Token 基准中的全语料库基线是真实代理不支付的上限。此基准模拟代理在没有图谱时**实际**做什么：

1. 从配置的 `agent_questions:` 列表中每个问题派生搜索词（通过 `search.extract_query_identifiers` 的标识符形 Token，加普通关键词；无时不回退到 `search_queries` 查询字符串）。
2. 纯 Python grep 遍历语料库（无需外部 `rg`/`grep` 二进制），按总不区分大小写匹配计数排序源文件（确定性；平局按路径打破）。
3. 读取 top-3 文件并以 `chars/4` 计算 Token 数作为 `baseline_tokens`。
4. 与同一问题的图谱查询成本比较（5 个混合搜索结果 + 每结果最多 5 条邻居边——与独立基准相同的计算）。

输出：`evaluate/results/<repo>_agent_baseline_<date>.csv`，每个问题含 `baseline_to_graph_ratio`。任一侧为零的行标记为 `status=no_graph_results` / `status=no_baseline_match` 并从聚合中排除（`agent_baseline.aggregate`）。尚无标准捕获；数字将在捕获后添加到上方标准块——测量前不引用。

## 每周 CI 运行（仅报告）

`.github/workflows/eval.yml` 每周一 06:23 UTC 运行（加手动 `workflow_dispatch`），对两个最小的固定配置（`httpx`、`flask`）运行 `token_efficiency`、`impact_accuracy` 和 `agent_baseline` 基准。上传 CSV 作为产物并写入作业摘要表。故意设为**仅报告**：回归目前不会使默认分支失败。

## 哪个基准测量什么

仓库中有四个不同的 "Token" 基准。它们都是有效的但测量不同场景：

| 基准 | Naive 基线 | 图谱成本 | 回答的问题 |
|---|---|---|---|
| `code_review_graph/eval/benchmarks/token_efficiency.py` | 特定提交的**变更文件内容**总和 | 完整 `get_review_context()` JSON | "图谱比只读 diff 文件更便宜吗？" |
| `code_review_graph/eval/benchmarks/agent_baseline.py` | 问题的标识符的 **grep top-3 文件** | 每问题 5 个搜索结果 + 5 条邻居边 | "图谱比现实的 grep-and-read 代理更便宜吗？" |
| `code_review_graph/eval/token_benchmark.py` | 无——绝对每工作流成本 | 5 次 MCP 工具响应总和 | "完整的代理工作流花费多少 Token？" |
| `code_review_graph/token_benchmark.py`（独立） | 仓库中**所有源文件**总和 | 每问题 5 个搜索结果 + 5 条邻居边 | "图谱比读取整个仓库更便宜吗？" |

`code_review_graph/eval/benchmarks/token_efficiency.py` 的数字对于小提交可能**低于 1.0×**（`get_review_context` 携带影响半径元数据和源片段，超过微小变更文件集）。独立基准数字**总是很大**因为基线是整个仓库——这就是 README 以中位数（~82×）为首并将 528× 视为最大值的原因，也是 `agent_baseline` 作为现实中间地带存在的原因。选择与你要讨论的场景匹配的基准。

## 生成图表

`diagrams/` 中的 9 个图由 `diagrams/generate_diagrams.py` 生成。Excalidraw 源文件（`.excalidraw`）被 gitignore（`.gitignore` 中 `*.excalidraw` 行）；只有渲染的 PNG 被跟踪。基准刷新后重新生成：

```bash
uv run python diagrams/generate_diagrams.py
# 在 https://excalidraw.com 打开每个 .excalidraw 以渲染/导出
```

## 故障排查

**`git clone failed`** — 网络或上游速率限制。修复是干净重试；评估设计上不自动重试（显式失败 > 静默回退）。

**`git checkout <sha> failed`** — 上游重写历史或移除了 SHA。提交 issue 附上失败的配置，以便我们重新固定。

**独立基准中 `No embeddings found in this graph`** 警告——你跳过了步骤 3。运行它。

**运行间社区 ID 不同** — 确保你在播种的 `communities.py` 上。检查 `grep _LEIDEN_SEED code_review_graph/communities.py`。你可以通过 `CRG_LEIDEN_SEED=<int>` 覆盖种子，但所有协作者必须就同一值达成一致。

**`naive_corpus_tokens` 与标准表不同** — 确保每个 `evaluate/test_repos/<name>` 内的 `git rev-parse HEAD` 与对应配置文件中的 `commit:` 字段匹配。如果不匹配，删除克隆让步骤 2 在固定 SHA 重新克隆。
