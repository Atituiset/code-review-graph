# 常见工作流

本篇把前面学过的工具串成三个日常场景：审查改动、探索陌生代码库、评估影响面。每个场景给出工具调用顺序和可以直接对 AI 说的自然语言提示词——你不需要记工具名，AI 会自己挑选；但了解背后的调用顺序，能帮你判断 AI 的回答靠不靠谱。

前提：图谱已建好且是最新的（`code-review-graph build` 之后用 `update` 或 `watch` 保持新鲜），MCP 已配置进你的 AI 工具。

## 场景一：审查一个 PR 或本地改动

这是最核心的场景。目标：在有限 token 内，让 AI 看到"改了什么、风险多大、有没有测试兜住"。

推荐顺序：

1. **`detect_changes_tool`**（`code_review_graph/main.py:633`）：第一步永远是它。它基于 git diff（默认基准 `HEAD~1`）找出本次改动的函数，给每个函数算风险评分，并按风险从高到低排出审查优先级。返回里还包含 `affected_flows` 和 `test_gaps`。
2. **`get_review_context_tool`**（`code_review_graph/main.py:289`）：拿到风险清单后，取改动相关的源码片段。它按影响半径（默认向外 2 层）收集代码，每文件最多截取指定行数，并按 token 预算裁剪——给 AI 的是"够用的上下文"，不是整仓库。
3. **`get_affected_flows_tool`**（`code_review_graph/main.py:529`）：看这次改动踩中了哪些执行流、这些流的 criticality 多高。改动一个工具函数和改动登录主流程上的一个函数，同样是一行 diff，分量完全不同——流告诉你分量。
4. **看 `test_gaps`**：`detect_changes_tool` 的返回里直接带有测试缺口清单（改动中没有任何 `TESTED_BY` 关系的函数，见 `code_review_graph/changes.py:469-488`）。让 AI 优先审这些没测试的函数，并可以顺手让它补测试。

可以直接对 AI 说的提示词示例：

> "用 detect_changes 审查我当前未提交的改动，按风险从高到低列出需要我重点看的函数，并说明每个函数为什么风险高。"

> "对这次 PR 生成审查上下文，重点看风险评分最高的前三个函数，检查它们的改动有没有破坏现有行为。"

> "这次改动影响了哪些执行流？有没有踩中 criticality 高的关键流程？"

> "列出本次改动中的测试缺口，为其中风险最高的两个函数起草单元测试。"

等价的 CLI 用法（不接 MCP 时用）：

```bash
code-review-graph detect-changes --brief   # 只读分析：风险摘要 + token 节省面板
code-review-graph update --brief           # 图过期时：先增量更新再看摘要
```

审查场景值得多说一句"如何核对 AI 的说法"。图工具返回的是结构化数据，AI 的审查意见是建立其上的推理——前者可查，后者可能出错。当 AI 声称"这个改动会影响 X 模块"时，你可以自己跑一条 `code-review-graph query callers_of <函数名>` 验证；当 AI 说"这个函数没有测试"时，`code-review-graph query tests_for <函数名>` 一秒就能证伪。把 AI 当审查员、把图当卷宗，两边对着看，是最稳的用法。

## 场景二：探索陌生代码库

刚接手一个项目，或者要改一个从没读过的模块。目标：花最少 token 建立"这个仓库大致长什么样"的心智地图。

推荐顺序：

1. **`get_minimal_context_tool`**（`code_review_graph/main.py:192`）：先要一份极简上下文——仓库的关键统计和最重要的入口信息，token 开销最小，适合"先探一探"。
2. **`get_architecture_overview_tool`**（`code_review_graph/main.py:608`）：看架构总览——仓库大致分成哪几个社区、主要的流有哪些、枢纽节点是谁。这是"地图的图例"。
3. **`list_communities_tool`**（`code_review_graph/main.py:552`）：列出社区清单（按大小或内聚度排序）。社区是自动发现的"模块划分"，找到与你任务相关的那个社区，再看 `get_community_tool` 里的成员。
4. **`semantic_search_nodes_tool`**（`code_review_graph/main.py:322`）：有了大致方向后，按名字、关键词或语义搜索具体的函数/类，钻进去读代码。如果跑过 `code-review-graph embed`，还能按"意思相近"搜索；否则退化为全文检索。

可以直接对 AI 说的提示词示例：

> "我对这个仓库完全不熟。给我一份架构概览：它大致分成哪几个模块，各自的职责是什么？"

> "列出代码量最大的几个社区，我想先了解核心模块在哪里。"

> "我要加一个新的支付方式。先帮我找到现有支付相关的社区和类，再说说新代码大概应该放哪。"

> "搜索和 'token 刷新' 相关的函数，告诉我它们之间的调用关系。"

等价的 CLI 用法：

```bash
code-review-graph architecture              # 架构总览
code-review-graph communities --sort size   # 社区清单
code-review-graph search "refresh token"    # 按关键词搜符号
```

探索阶段的一个小窍门：多数 MCP 工具支持 `detail_level="minimal"` 参数，返回压缩后的摘要而非完整结果（如 `code_review_graph/main.py:278`）。初筛阶段用 minimal，锁定目标后再要 standard 详情，能进一步压低 token 消耗。

## 场景三：评估改动影响面

准备改一个被广泛使用的函数，动手之前想知道"会波及多大范围"。目标：把"我觉得应该没事"变成"图上看着确实没事"。

推荐顺序：

1. **`get_impact_radius_tool`**：以目标函数为起点，沿 `CALLS`、`INHERITS` 等边向外扩散（默认 2 层），算出完整的"爆炸半径"（blast radius）——哪些函数、文件、流会被波及，按影响权重排序。不同类型的边权重不同：`CALLS` 是 1.0，`IMPORTS_FROM` 只有 0.5（权重表见 `code_review_graph/constants.py:57-66`），扩散时强关系优先。
2. **`query_graph_tool` 配 `callers_of`**（`code_review_graph/main.py:247`）：精确列出"谁直接调用了这个函数"。影响半径给的是带权重的全景，`callers_of` 给的是需要逐一确认的直接调用方清单。

`query_graph_tool` 支持的常用模式（完整清单见 `code_review_graph/main.py:256-272`）：

- `callers_of` / `callees_of`：谁调用了它 / 它调用了谁；
- `tests_for`：覆盖它的测试有哪些；
- `inheritors_of`：哪些类继承了它；
- `imports_of` / `importers_of`：它导入了什么 / 谁导入了它；
- `children_of`：一个文件或类内部包含哪些节点；
- `file_summary`：一个文件里所有符号的概览。

可以直接对 AI 说的提示词示例：

> "我准备把 `UserService.login` 的签名改一下。先算出它的影响半径，告诉我哪些文件和流会受波及。"

> "列出所有直接调用 `hash_password` 的函数，我需要逐一确认它们的传参方式。"

> "这个函数有多少测试覆盖？改名之前，先告诉我 `tests_for` 的结果，改完我要跑哪些测试。"

> "对比这两个函数的影响半径：如果只能重构其中一个，动哪个的代价更小？"

评估影响面时有个实用习惯：先看影响半径的"总量"（波及多少节点、多少文件），再用 `callers_of` 看"明细"（具体是哪些调用方）。总量异常大往往意味着你改的是一个枢纽节点，这时候值得先停下来想想有没有改动更小的替代方案——比如新增一个包装函数，而不是修改被三十处调用的原函数。

等价的 CLI 用法：

```bash
code-review-graph impact --files src/auth.py          # 算指定文件的影响面
code-review-graph query callers_of auth.py::hash_password
code-review-graph query tests_for auth.py::UserService.login
```

## 三个场景的共同点

三个场景其实是同一套思路的不同入口：**先用图把范围缩到最小，再把省下来的 token 花在真正重要的代码上**。审查场景从 diff 出发，探索场景从社区出发，影响面场景从单个函数出发，但最终都落在同一个事实上——AI 看到的永远是从图里精确切出来的一小片，而不是整个仓库。

## 开始之前的检查清单

无论哪个场景，动手前花十秒钟确认三件事，可以避免大部分"AI 答得不对"的情况：

1. **图存在吗？** 仓库根目录下应有 `.code-review-graph/graph.db`；没有就先 `code-review-graph build`。
2. **图新鲜吗？** 代码改过之后图不会自动变。手动跑一次 `code-review-graph update`，或开着 `code-review-graph watch` / `crg-daemon`，或在 `serve` 时加 `--auto-watch`。如果装了平台 hooks（`code-review-graph install` 默认会装），保存文件时也会自动触发更新。
3. **问得具体吗？** "看看这个仓库"太宽泛，AI 可能只用一两个工具就草草回答。带上目标——"我要改 X，先评估影响面"——AI 才会走到正确的工具链上。

## MCP 工具与 CLI 对照

同一套图引擎，两个入口。下表帮你把 AI 侧的工具名和终端里的命令对应起来（MCP 工具定义见 `code_review_graph/main.py`，CLI 定义见 `code_review_graph/cli.py`）：

| MCP 工具 | 对应 CLI |
| --- | --- |
| `detect_changes_tool` | `code-review-graph detect-changes` |
| `get_impact_radius_tool` | `code-review-graph impact` |
| `query_graph_tool` | `code-review-graph query <pattern> <target>` |
| `semantic_search_nodes_tool` | `code-review-graph search` |
| `list_flows_tool` / `get_affected_flows_tool` | `code-review-graph flows` |
| `list_communities_tool` | `code-review-graph communities` |
| `get_architecture_overview_tool` | `code-review-graph architecture` |
| `list_graph_stats_tool` | `code-review-graph status` |

在 CI 或脚本里用 CLI，在编辑器里让 AI 走 MCP，两边看的是同一份 `graph.db`。

## 写好提示词的小贴士

- **点名要依据**："按风险评分排序""列出测试缺口"——让 AI 把工具返回的结构化字段用出来，而不是泛泛总结。
- **限定范围**："只看 `src/payments/` 下的改动""只查 Function 类型"，能明显减少无关结果。
- **串联追问**：图工具返回的是结构化数据，适合多轮对话逐步深入——先要影响面，再挑其中一个调用者问 `callers_of`，最后让 AI 读具体源码。
- **让 AI 解释评分**：风险分的每个因子（流参与度、测试覆盖、调用者数、安全关键词）都来自图上可查的数据，追问"这个 0.8 分是怎么来的"能得到可核对的解释。

## 结果不符合预期时

几个最常见的排查方向：

- **AI 说"没有找到图"或结果明显过时**：先跑 `code-review-graph status` 看图是否存在、有多少节点；存在但过时就 `code-review-graph update`。MCP 工具返回里附带的 provenance（建图时间、`head_matches_build` 标志）也能帮你确认新鲜度。
- **语义搜索答非所问**：检查是否跑过 `code-review-graph embed`。没有向量索引时 `semantic_search_nodes_tool` 会退化为关键词/全文匹配（`code_review_graph/main.py:331-337`），"按意思搜"的效果自然出不来。
- **某个仓库完全查不到**：如果你在用多仓库模式，用 `code-review-graph repos` 确认它已注册，未注册则 `code-review-graph register /path/to/repo`。
- **改动分析是空的**：`detect_changes_tool` 默认基准是 `HEAD~1`。如果你的改动还没提交，或与上一次提交在同一处，先确认 git 状态，必要时让 AI 指定别的基准（CLI 对应 `--base` 参数）。

想深入工具内部实现（影响半径怎么扩散、风险分怎么算、token 预算怎么裁剪），可以继续读进阶篇的 [查询引擎](../advanced/query-engine.md) 与 [Token 经济](../advanced/token-economy.md)。
