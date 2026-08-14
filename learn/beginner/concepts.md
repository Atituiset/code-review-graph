# 核心概念：图、流、社区

code-review-graph 的所有功能都建立在四层数据结构之上：节点和边组成的**图**、沿调用边追出来的**执行流**、聚类得到的**社区**，以及综合前三者算出的**风险评分**。本篇用直觉化语言逐个解释。读者不需要任何编译原理背景。

## 1. 图：节点与边

### 节点：代码里的"东西"

把代码仓库想象成一座城市，图里的**节点（node）**就是城里的建筑。code-review-graph 识别五种节点：

- `File`：一个源文件；
- `Class`：一个类；
- `Function`：一个函数或方法；
- `Type`：类型定义（如接口、结构体、类型别名）；
- `Test`：测试函数或测试类。

每个节点有一个全局唯一的名字，格式是 `文件路径::类.符号`（生成逻辑见 `code_review_graph/graph.py:2159-2165`）。比如 `auth.py` 里 `UserService` 类的 `login` 方法，唯一名就是：

```
auth.py::UserService.login
```

顶层函数没有所属类，就是 `auth.py::hash_password`。这个格式保证了哪怕两个文件里都有同名函数，也不会混淆。

### 边：节点之间的"关系"

**边（edge）**是节点之间带类型的连线，表示一种代码关系。主要边类型（见 `code_review_graph/constants.py:57-66`）：

- `CALLS`：A 调用了 B。这是最重要的一种边，权重 1.0；
- `IMPORTS_FROM`：A 文件导入了 B；
- `INHERITS`：A 类继承自 B 类；
- `IMPLEMENTS`：A 类实现了 B 接口；
- `CONTAINS`：A 包含 B，比如文件包含函数、类包含方法；
- `TESTED_BY`：A 被测试 B 覆盖；
- `REFERENCES`：A 引用了 B（不属于上面任何一类的泛化引用）。

还是用城市的比方：`CALLS` 是道路，`TESTED_BY` 是消防栓到建筑的管线，`CONTAINS` 是"这栋楼在这个街区里"。有了边，"改了这个函数谁会受影响"就从人肉搜索变成了沿道路走两步的事。

每条边在影响分析里有权重：`CALLS` 是 1.0，`INHERITS`/`IMPLEMENTS` 是 0.9，`IMPORTS_FROM` 只有 0.5。直觉是：导入一个模块不代表你依赖它的每个细节，但调用一个函数通常是强依赖。

### 一个小例子

下面这段代码建图后大致长这样：

```python
# auth.py
class UserService:
    def login(self, user, pwd):
        return authenticate(user, hash_password(pwd))

def authenticate(user, hashed): ...
def hash_password(pwd): ...
```

节点：`auth.py`（File）、`auth.py::UserService`（Class）、`auth.py::UserService.login`、`auth.py::authenticate`、`auth.py::hash_password`（三个 Function）。边包括：

- `auth.py -CONTAINS-> auth.py::UserService`（文件包含类）；
- `auth.py::UserService -CONTAINS-> auth.py::UserService.login`（类包含方法）；
- `auth.py::UserService.login -CALLS-> auth.py::authenticate`；
- `auth.py::UserService.login -CALLS-> auth.py::hash_password`。

注意影响传播的方向：`login` 调用 `hash_password`，所以改 `hash_password` 时受影响的是 `login`——影响沿调用边的**反方向**扩散，从被改者走向依赖它的人。`TESTED_BY` 恰好相反（从生产代码指向测试），改生产函数时沿正向找到该跑的测试；`CONTAINS` 不参与影响扩散，因为改一个文件本来就会把里面所有节点当作种子（方向定义见 `code_review_graph/constants.py:78-88`）。

## 2. 流：一条请求走过的路

**流（flow，执行流）**回答的问题是："一个外部请求进来后，代码实际会按什么顺序跑过哪些函数？"

检测分两步（`code_review_graph/flows.py`）：

**第一步，找入口点（entry point）**。入口点是"程序从外部被触发的地方"，满足以下任一条件（`code_review_graph/flows.py:165-211`）：

- 没有任何其他函数调用它（比如命令行的 `main`）；
- 带框架装饰器（decorator，一种"贴在函数头上的标签"语法），比如 Flask 的 `@app.get("/login")`——它虽然没人显式调用，但 HTTP 请求会触发它；
- 名字符合约定俗成的入口模式，比如 `main`、`test_*`、`handle_*`、`on_*`、`lambda_handler`、Android 的 `onCreate`、Servlet 的 `doGet`、React 类组件的 `render` 等（完整模式表见 `code_review_graph/flows.py:75-114`）。

**第二步，沿 `CALLS` 边向前遍历**。从每个入口点出发，用广度优先搜索（BFS，一层层向外扩展的遍历方式）沿着调用边往下走，得到的函数序列就是一条流。比如：

```
POST /login → login_handler → authenticate → hash_password
```

这条流告诉你：`/login` 请求最终会经过这三个函数。改动其中任何一个，这条流上的行为都可能变化。

**每条流有一个 criticality（关键性）评分**，0 到 1，越高越关键。评分因子（`code_review_graph/flows.py:325-394`）：

- 横跨多少文件（权重 0.30）——跨文件越多越可能是主干流程；
- 是否调用了图外的外部代码（0.20）；
- 是否涉及安全敏感函数（0.25）；
- 流上有多少函数没有测试覆盖（0.15）；
- 流的深度（0.10）。

流的用途：审查改动时，`get_affected_flows_tool` 告诉你"这次改动踩中了哪几条流、这些流有多关键"，比单看改了哪几个函数更能反映真实影响。

## 3. 社区：自动发现的"模块划分"

**社区（community）**是把图中联系紧密的节点聚成一堆的结果。用的是 **Leiden 算法**——一种图聚类算法，思想类似"物以类聚"：反复调整分组，让组内的边尽量密、组间的边尽量稀疏（实现见 `code_review_graph/communities.py`，通过 igraph 库运行，没装 igraph 时退化为按文件目录分组）。

直觉化的理解：如果调用关系是"谁常和谁打电话"，社区就是"经常互相打电话的一群人"。一个写得还不错的项目里，社区往往天然对应架构上的模块——"鉴权相关的一坨函数"聚成一个社区，"数据库访问"聚成另一个。

社区的价值在于给 AI 提供了一个**架构中间层**：

- 没有社区时，AI 面对的是一个仓库里几千个函数的扁平列表；
- 有了社区，AI 可以先看"这个仓库大致分成哪 8 个社区、每个社区叫什么、有多大"，再钻进关心的那个。这正是 `get_architecture_overview_tool` 和 `list_communities_tool` 所做的事。

每个社区有自动生成的名字（从成员函数名中提取高频词）和 cohesion（内聚度，组内联系有多紧密）评分。跨社区的调用还是风险评分的一个信号——一个被很多"别的社区"调用的函数，往往是公共枢纽，改它要格外小心。

顺着这个思路，工具里还有两个进阶概念，知道名字即可：

- **hub node（枢纽节点）**：被非常多函数调用的节点，类似城市里的中央车站，可用 `get_hub_nodes_tool` 列出（`code_review_graph/main.py:807`）；
- **bridge node（桥梁节点）**：连接不同社区的节点，类似两区之间的跨海大桥，可用 `get_bridge_nodes_tool` 列出（`code_review_graph/main.py:827`）。

这两类节点都是"改动时要格外小心"的天然候选。

顺带一提：Leiden 算法内部有随机性，但 code-review-graph 固定了随机种子（默认 42，可用环境变量 `CRG_LEIDEN_SEED` 覆盖，见 `code_review_graph/communities.py:17-21`），所以同一个仓库重复建图得到的社区划分是稳定可复现的——这对对比前后两次分析结果很重要。

## 4. 风险评分：把上面的一切汇成一个数

当你改动一个函数时，`detect_changes_tool` 会给它算一个 0 到 1 的**风险评分（risk score）**，越高越需要仔细审查。评分因子与上限（`code_review_graph/changes.py:313-367`）：

- **流参与度**（最高 0.25）：它出现在多少条执行流里，并按那些流的 criticality 加权——踩在关键流上的函数风险高；
- **跨社区调用**（最高 0.15）：有多少来自其他社区的调用者——枢纽函数风险高；
- **测试覆盖**（0.30 起步，随测试增多降到 0.05）：没有 `TESTED_BY` 边的函数直接吃满 0.30，有 5 个以上测试的只算 0.05；
- **安全敏感性**（0.20）：函数名命中安全关键词（如 auth、password、token 一类）直接加 0.20；
- **调用者数量**（最高 0.10）：调用者越多风险越高，20 个调用者封顶；
- **改动频率**（可选，最高 0.15）：加 `--churn` 后，该文件最近 90 天的提交次数也会计入——老在改的地方容易再出问题。

举个完整例子：你改了 `auth.py::UserService.login`。它参与 3 条流（其中一条 criticality 很高）、被其他社区的 4 个函数调用、没有任何测试、名字含 `login` 命中安全关键词——这些因素叠加，风险分可能到 0.7 以上，AI 会把它排在审查优先级第一位。相反，一个只被一处调用、有三个测试、不参与任何流的工具函数，风险分可能只有 0.1 左右。

粗略算一遍上面这个例子的账，感受一下各因子的分量：

- 流参与度：3 条流、按 criticality 加权后触顶 → +0.25；
- 跨社区调用：4 个外部社区调用者 × 0.05 → +0.15（触顶）；
- 测试覆盖：没有任何测试 → +0.30；
- 安全关键词：`login` 命中 → +0.20；
- 调用者数量：比如共 8 个调用者，8/20 → +0.04。

合计约 0.94 封顶前落在 0.9 上下——一个"高危改动"的典型画像。而那个只被一处调用、有三个测试、不在任何流里的工具函数：流 0 分、跨社区 0 分、测试项约 0.30 − 0.15 = 0.15、无安全词、调用者约 0.01，总分 0.16 左右。同一行 diff，优先级完全不同——这就是风险评分存在的意义。

整个改动集的总风险分取所有改动函数中的最大值（`code_review_graph/changes.py:463-464`），同时工具会列出 **test gaps（测试缺口）**：本次改动中没有任何测试覆盖的函数清单。

## 小结

- **图**回答"代码里有什么、谁和谁有关系"；
- **流**回答"请求实际会怎么走、哪条路最关键"；
- **社区**回答"代码大致分成哪几块"；
- **风险评分**把三者综合成"这次改动最该先审哪里"的排序依据。

四者是层层递进的关系：边织成图，图里沿 `CALLS` 追出流、按密度聚出社区，风险评分再引用流、社区、测试边和调用边四个来源。你日常使用的每个 MCP 工具，本质上都是在这四层结构上做一次查询：`detect_changes_tool` 用到了全部四层，`get_affected_flows_tool` 查流层，`list_communities_tool` 查社区层，`query_graph_tool` 查最基本的节点与边。

下一篇 [常见工作流](./workflows.md) 看这些概念如何组合成日常用法。
