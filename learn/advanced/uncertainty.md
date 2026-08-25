# 可信度报告：空结果为什么不等于"不存在"

前几章讲图怎么建、怎么查。本章讲一个更微妙的问题：**查询返回 0 的时候，调用方该相信什么？** v2.3.8 为此引入了整个项目里最小也最锋利的子系统——`uncertainty.py`（约 400 行，无外部依赖）。

## 问题：一个裸的 0 有两种含义

agent 问 `query_graph(pattern="callers_of", target="UserService.save")`，得到 `result_count: 0`。这句话有两种完全不同的解读：

1. **真的没人调用它**——可以安全删除、可以跳过审查；
2. **图看不见调用者**——PHP 容器注入的调用本来就不在图里；或者图是上周建的，这周刚加的调用者不存在于任何索引。

两种解读指向完全相反的行动。而 LLM agent 的实际行为模式是：拿到裸 0 后，要么得出错误结论（"没有调用者，删吧"），要么发起全仓 grep 自行验证——一次 grep + 读文件轻松烧掉数千 token，恰好摧毁了整个项目的 token 经济学（第 7 章）。issue #314/#819/#850/#851 反复报告的都是这个形态的事故。

## 设计约束：三条铁律

`uncertainty.py` 的模块 docstring 开宗明义，实现严格遵守：

1. **只在空结果时附加**。有结果的响应**逐字节不变**——不带 confidence 键（tests/test_uncertainty.py 对此有专门断言）。正常路径零开销，这是它能挂上所有查询工具而不污染 token 预算的前提；
2. **一句话，≤140 字符**（`MAX_CONFIDENCE_CHARS = 140`，uncertainty.py:42）。截断用 `~` 标记，空白折叠成单行。约 30 个 token 的诚实句子，换掉数千 token 的错误验证路径；
3. **建议性的，永不致命**（uncertainty.py:378-382）。生成置信度的任何内部失败都降级为 None，绝不把工具调用炸掉。

## 置信度阶梯：七级归因

`empty_query_confidence`（uncertainty.py:343）按优先级归因，从"图完全不可用"逐级下探到"验证过的真实空缺"：

| 级 | 情形 | 输出要点 |
|---|---|---|
| 1 | 图为空 | "nothing is indexed, so this 0 says nothing about the code; run build" |
| 2 | 目标未索引 | "no node matching '<target>', so this 0 is not evidence that none exist" |
| 3 | 图陈旧 + 目标未索引 | "the graph predates HEAD; run update first" |
| 4 | 图陈旧（按提交） | "built at an older commit than HEAD; this 0 may be out of date" |
| 5 | 图陈旧（按文件 mtime） | "<file> changed after the last build" |
| 6 | 已知语言盲区命中 | 见下表 |
| 7a | 验证过的真实空缺 | "'<target>' is indexed and the graph is current, so this 0 is a real absence" |
| 7b | 已索引但未验证时效 | "no such edge is recorded; graph currency unverified" |

阶梯的关键在 **7a/7b 的区分**：只有当陈旧检查**真的跑过且通过**时才说"真实空缺"（`currency_verified`）；没跑过检查就只说"未记录"。措辞的强度与证据的强度严格对齐——这是整章的灵魂。

### 陈旧检测的两个独立信号

`_staleness`（uncertainty.py:292）并行检查：

- **存储的 `git_head_sha` vs 当前 HEAD**：抓到"别的分支/新提交之后没重建"；
- **目标文件的 mtime vs 构建时间戳 `last_updated`**：抓到"未提交的本地编辑"——这个信号常被忽略，但对 agent 场景致命：你刚改完文件让 agent 审查，图还是改之前的。

两个信号任一命中即判陈旧，并分别给出对应的修复动词（update / rebuild）。

## 已知盲区表：诚实的边界清单

第 6 级归因查一张手工维护的语言盲区表（`LANGUAGE_GAPS`，uncertainty.py:83-156）。每条都是**被 issue 追踪过的真实缺口**，且按查询 pattern 分域（调用类/导入类）精确限定：

| 语言 | 影响的查询 | 盲区说明 |
|---|---|---|
| PHP | imports_of / importers_of / impact_radius | `include`/`require` 不建导入边（#819） |
| PHP | callers_of / callees_of / tests_for | 容器解析与构造器注入的调用不可静态追踪（#850、#851） |
| JS/TS/TSX | handlers_of / endpoints_for | 路由注册不索引，Endpoint 边是 Spring-only |
| JS/TS/TSX | imports_of / importers_of | npm 别名导入不解析（#343） |
| JS/TS/TSX | 调用类 | 回调落在 REFERENCES 不在 CALLS；`obj[name]()` 动态调用不解析 |
| Java | 调用类 | AOP 切面与反射调用不可追踪（#592） |
| Go | inheritors_of | 接口满足是结构化的、从不声明，实现者可能缺失 |
| C# | 调用类 | DI 容器注册不可追踪，接口型调用者可能缺失 |
| Python | 调用类 | `getattr` 分发与装饰器注册不可追踪 |

这张表有一条容易被忽略的设计纪律：**它只列仍然存在的缺口**。docstring（uncertainty.py:17-20）明确说，已修复的能力必须从表里移除——Go 的方法 receiver 解析（上一章的八提交案例）、Kotlin 导入、点分多段相对导入都已修好，所以不在表中。留着已修复的条目会让每次空结果都背上不必要的免责声明，稀释真正重要的警告。同样刻意的还有：`references_to` 被排除在调用类警示之外——因为 REFERENCES 恰恰就是未解析调用的落点，查它不需要额外提醒。

## 三个附着点

置信度目前挂在三个工具的空结果路径上：

- **`query_graph`**：`status: not_found` 分支与零结果分支都挂（query.py 内两处）；
- **`get_impact_radius`**：爆炸半径为空时——"改动没人依赖"同样是需要归因的 0；
- **`semantic_search_nodes`**：零命中时提示搜索覆盖的是名字/路径/签名而非源码文本。

impact 与 search 各有自己的措辞变体（`empty_impact_confidence` / `empty_search_confidence`），但共享同一个七级阶梯和同一套陈旧检测。

## 放回更大的图景：一条"诚实清单"的主线

孤立地看，这是一个 400 行的小模块；放进全书脉络，它是项目认识论工程的最新一环。同一条主线上的既有机制：

| 机制 | 层 | 诚实的内容 |
|---|---|---|
| `confidence_tier`（EXTRACTED/INFERRED） | 存储层 | 这条边是抽出来的还是推出来的 |
| `truncated: true` + "showing N of M" | 工具层 | 这个答案被裁过、怎么调大 |
| `_assert_graph_matches_root` 拒绝 | 增量层 | 这个图不是这个仓库的，我拒绝销毁它 |
| 手改的 instruction 区块不动 | 安装层 | 这段文字是你的，我不覆盖 |
| 空结果的 confidence 字段 | 查询层 | 这个 0 是什么意义上的 0 |

共同点：**每个组件在自己的输出边界上声明自己认知的局限**，而不是假装完备。对人类用户这些标注是礼貌；对 LLM agent 它们是功能——agent 无法像人一样"感觉出"结果可疑，只能依赖机器可读的怀疑标记。一句 30 token 的真话，比 3000 token 的错误结论便宜两个数量级，这就是本模块的成本收益模型。

## 已知局限

- **只覆盖空结果路径**：结果非空但有缺口（比如调用者列表缺了一条容器注入边）不会触发任何提示——缺口藏在结果中间时无从归因。这是原理性限制，不是遗漏；
- **140 字符上限**意味着复杂情形只能给出主因（比如"陈旧 + PHP 容器盲区"只报先命中的那个）；
- **mtime 陈旧信号有盲区**：构建之后文件被 touch 但内容未变会误报陈旧（偏保守方向的误报，可接受）；反之极短间隔内的写入依赖文件系统 mtime 精度；
- **盲区表是手工维护的**：新的静态分析缺口出现时，表更新依赖维护者的自觉——好在测试断言每条文案 ≤140 字符且按 pattern 正确匹配，结构性漂移会被 CI 拦住。

## 小结

这一章的项目最小，但回答的问题最根本：一个把"找代码"压缩成查表的系统，如何对表查不到的情形保持诚实。它的存在让前面各章的取舍闭环了——启发式解析允许缺边，唯一性约束允许放弃歧义，token 预算允许截断；而 uncertainty 层保证每一次放弃都被显式说出。图不是真理，图是带置信标注的证据集合——这个定位最终落实为一个 JSON 字段。
