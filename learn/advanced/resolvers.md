# 语义解析层：Resolver 机制

tree-sitter 是单文件、无类型的：它知道这一行有个 `foo.bar()` 调用，但不知道 `foo` 是什么类型、`bar` 定义在哪个文件。code-review-graph 的答案不是做全量类型推断（太贵、太脆、对动态语言本身就不可靠），而是一套**两阶段模式**：

1. **解析期**：故意留下未解析的裸目标（bare target），但把现场证据存进边的 `extra` JSON——`receiver`（调用发生的变量名）、`receiver_scope`、`field_name`（字段声明的类型）等；
2. **构建后**：等全图（所有文件、所有 import、所有继承边）都在 SQLite 里之后，跑各语言的 **Resolver pass**，用全局信息修补这些裸边。

这个模式本质是用"证据持久化 + 延迟解析"替代"在线类型推断"：单文件解析保持廉价、无上下文依赖（第 1 章进程池的前提），全局解析则退化为对 SQLite 的批量 UPDATE——可以在一张表里看到全图，做完一次提交。

## 通用约定

所有 Resolver pass 遵守同一套纪律：

- **幂等**：重复执行结果相同，可以安全地在每次增量更新后重跑；- **非致命**：整体 try/except，失败只记 warning，不拖垮主构建；
- **按变更语言条件触发**：增量更新只跑相关语言的 resolver——Python 文件变了才跑 `python_resolver`，`.php`/`.rs`/`.cs` 变了才跑 `scoped_resolver`，以此类推。注意触发条件把 stale/missing 文件也算进去，保证"只删除了文件"的变更也能清理派生态（`incremental.py:1313-1337`）；
- **唯一性优先**：跨 Resolver 反复出现的原则是"证据唯一才解析"——匹配不上或匹配多个时保持裸名。宁可不解析，不可错解析：错解析的边会污染 flow 和影响半径，不解析只是信息缺失。

幂等性的实现方式因 pass 而异，但只有两个模式：**重写式**（scoped/spring/temporal：把裸边 UPDATE 成解析后边，重跑时已解析的边不再匹配裸名条件，自然收敛）和**重建式**（event_resolver：虚拟边整体删除再按当前证据重新合成，天然与历史状态无关）。两种模式都不需要记录"上次跑到哪"，这是它们能安全挂在每次增量更新之后的原因。

## 各 Resolver 逐一拆解

### tsconfig_resolver：唯一在解析期使用的

`tsconfig_resolver.py` 是例外中的例外：它在**解析期**被 parser 直接调用（parser.py:13588-13589），把 TS/JS 的非相对 import（如 `@/utils/foo`）按 `tsconfig.json`/`jsconfig.json` 的 `compilerOptions.paths` 别名表解析成真实文件路径，让 `IMPORTS_FROM` 边直接指向文件而非别名字符串。

它能进解析期是因为别名表是纯静态配置，不需要全图信息——这正好划出了两阶段的分界线：**只依赖配置/局部知识的在解析期做，依赖全图的留到构建后**。

### python_resolver：唯一路径后缀匹配

`python_resolver.py` 解决 Python import 的裸模块名（`import utils.helpers`、`from x import y`）。策略是先收集全仓库 Python 文件路径，然后做**唯一路径后缀匹配**：裸模块串如果能且只能匹配一个仓库内文件的路径后缀，就解析为那个 File 节点；匹配不上（外部库）或匹配多个（同名歧义）就保持裸名。

实现上有个有意的破例：它直接访问 `store._conn` 私有连接，旁边挂着注释 "intentional: bounded post-build maintenance pass"——Resolver 层被明确视为对存储内部的、有界的维护通道，不走公共 API。这个破例集中出现在 resolver 层而非散落在业务代码里，边界是清楚的。

### scoped_resolver：PHP/Rust/C# 的 `Class::method`

PHP 的 `Foo::bar()`、Rust 的 `Type::assoc_fn()`、C# 的静态调用共享同一个模式：目标带作用域限定符但仍是裸名。`scoped_resolver.py` 构建后按 Class 名 + 方法名反查全图，重写为目标方法的 qualified name。

被改写的边标记 **`confidence_tier = 'INFERRED'`**（scoped_resolver.py:480-489）——因为 `Class::method` 的重名消解没有类型系统背书，是启发式推断，必须与 tree-sitter 直接抽出的 `EXTRACTED` 边区分开，供下游按可信度过滤。

### spring_resolver：字段注入表 → 唯一实现

Java/Spring 的依赖注入对静态分析是最坏情况：调用点只有接口类型，真实实现由容器在运行时决定。`spring_resolver.py` 的解析链：

```
receiver 变量名
  → @Autowired 字段声明的类型（来自边的 extra.field_name / 字段注入表）
  → 该接口在全图中的 INHERITS 实现
  → 实现唯一时，重写 CALLS 边指向具体实现；不唯一则保持接口级目标
```

"唯一实现才解析"（spring_resolver.py:170 附近）再次体现唯一性原则：一个接口有三个实现时，猜任何一个是引入错误，保持接口级目标只是粒度粗。

### temporal_resolver

Temporal workflow 的场景同构于 Spring：activity 调用打在 stub 代理对象上，真实类型藏在 stub 的声明类型里。`temporal_resolver.py` 的解析链是 receiver 变量名 → TEMPORAL_STUB 的 `extra.field_name` 声明类型 → 唯一 INHERITS 实现（见其模块 docstring，temporal_resolver.py:1-14）。可以把它看作 spring_resolver 的模式在一个特定框架上的实例化——两者共享"注入点声明类型 + 唯一实现"的推理骨架。

### event_resolver：合成虚拟边

Spring 的事件机制（`ApplicationEventPublisher.publish(...)` → `@EventListener`）连"注入"这条线索都没有：发布者和订阅者在源码层面完全解耦，唯一的联系是事件类型。

`event_resolver.py` 的做法是**合成虚拟 CALLS 边**：收集 `PUBLISHES`/`LISTENS_TO` 两类证据边，按事件类型和包匹配，把 publisher 与 listener 直接连起来，并维护合成的 Event 节点。虚拟边是派生态，每次以 rebuild 语义整体重建（event_resolver.py:45-49），防止 listener 删除/改名留下幽灵 CALLS 边——这正是第 2 章删除对账要触发它的原因。

### rescript_resolver 与 hcl_resolver

两个小众语言的收尾 pass：ReScript 因为走 regex 解析（第 2 章），跨文件引用解析全部推迟到构建后；HCL/Terraform 处理 `module.x.output` 这类资源引用。机制与目标图模型相同，只是证据形态不同。

## embeddings：可选的语义层

向量嵌入是与 Resolver 平行的另一层"语义补全"，定位不同：Resolver 修的是**结构性**裸边（确定性的谁调用谁），embeddings 提供的是**相似性**检索（模糊的"找类似代码"）。

- **5 个 provider**：local（sentence-transformers，默认、离线）、Gemini、MiniMax、OpenAI 兼容端点、Voyage（`embeddings.py` 中各 provider 类，约 275/359/630 行附近）；
- **向量存同一个 SQLite**（`embeddings` 表），查询用纯 Python 暴力余弦扫描（`_cosine_similarity`，embeddings.py:1060）——没有引入任何向量索引库。本地仓库的节点量级下，全表扫描是可接受的简单选择；
- **无向量时回退 FTS5/BM25** 关键词检索（`embeddings.py:1409` 的 hybrid search 入口，`search.py` 实现），语义搜索退化为关键词搜索而不是报错；
- **默认关闭**：云端 provider 会把源码派生文本传出本机并产生 API 成本，启用前有显式的 stderr 警告（`_warn_cloud_egress`，embeddings.py:843）。这与项目 local-first 定位一致：语义增强是可选项，离线是默认态。

provider 一览：

| provider | 类型 | 备注 |
|---|---|---|
| local | sentence-transformers | 默认，完全离线；未装依赖时为空操作 |
| Gemini | 云端 | `gemini-embedding-001` |
| MiniMax | 云端 | embo-01，1536 维 |
| OpenAI 兼容 | 云端/自建 | base_url 归一化后作为 provider 身份键 |
| Voyage | 云端 | — |

更换 provider 或模型会改变 `provider.name`，触发自动重嵌（embeddings.py:375 附近）——向量按"谁产生的"分区，不同模型的向量不会混在同一检索空间里被误比较。

## 诚实清单：存在但未接线的代码

仓库里有两个"半成品"，读代码时不要被误导：

- **`jedi_resolver.py`**：基于 [Jedi](https://jedi.readthedocs.io/) 的真类型推断 resolver——理论上能精确解析 Python 的 receiver 类型，比字符串启发式强一个量级。但它**没有接入任何构建路径**：全仓库搜索，没有别处 import 它。属于死代码/实验品。
- **`memory.py`**：同样存在但全仓库无引用。

另有一个非"死代码"但值得知道的规模约束：embeddings 的暴力余弦扫描是 O（节点数 × 维度） 的纯 Python 循环，节点数上到几十万量级后延迟会显著劣化——它没有近似最近邻索引，规模上限由这个选择决定。

它们的存在说明项目探索过更强的解析路线，最终选择了"证据 + 启发式 + 唯一性约束"这条更可控、无重型依赖的路——但探索的残骸留在了仓库里。如果未来要把 Jedi 接线，入口位置是现成的：它就是又一个遵守上述约定的构建后 pass。

## 附：Resolver 速查表
| Resolver | 语言 | 时机 | 证据来源 | 解析不到时 |
|---|---|---|---|---|
| `tsconfig_resolver` | TS/JS | **解析期** | tsconfig/jsconfig 的 `paths` | 保留别名裸串 |
| `python_resolver` | Python | 构建后 | 仓库文件路径后缀唯一匹配 | 保持裸模块名 |
| `scoped_resolver` | PHP/Rust/C# | 构建后 | `Class::method` 全图反查 | 保持裸名 |
| `spring_resolver` | Java | 构建后 | 字段注入类型 + 唯一 INHERITS | 停在接口级目标 |
| `temporal_resolver` | Java (Temporal) | 构建后 | stub 声明类型 + 唯一 INHERITS | 停在 stub 级 |
| `event_resolver` | Java (Spring Event) | 构建后 | 事件类型 + 包匹配 | 不合成虚拟边 |
| `rescript_resolver` | ReScript | 构建后 | regex 解析期存的证据 | 保持裸名 |
| `hcl_resolver` | Terraform/HCL | 构建后 | 资源引用路径 | 保持裸名 |

## 附：extra JSON 里的证据字段

两阶段模式能成立，全靠解析期把证据持久化进边的 `extra` JSON。常见字段：

- `receiver`：调用发生的接收对象变量名（`foo.bar()` 里的 `foo`）——spring/temporal 等 receiver 链的起点；
- `receiver_scope`：receiver 所在的作用域线索，缩小同名变量的歧义；
- `field_name`：字段/注入点声明的类型名——"变量名 → 类型"这步跳跃的关键；
- `julia_qualified_def` 等语言特定字段：专语言的解析提示（见 parser.py:4715-4720 的消费点）。

读 parser 代码时值得留意的一个对照：JS/TS 的调用边会同时保留**完整成员表达式**（`app.handle`，作为证据）和**裸方法名**（`handle`，作为外部调用的兜底目标）——解析策略可以在两者之间择优，而不是解析期就被迫二选一（parser.py:4722-4731 的注释解释了这一择优逻辑）。这正是"证据持久化"相对"当场解析"的核心优势：信息不丢，决策推迟到信息最全的时刻。

## 附：增量触发逻辑的实际形状

条件触发的代码（`incremental.py:1313-1337`，简化）长这样：

```python
python_changed = any(p.endswith(".py")
                     for p in set(all_files) | set(stale_files) | missing_paths)
python_stats = _run_python_resolver(store) if python_changed else None
...
scoped_changed = any(p.endswith((".php", ".rs", ".cs")) for p in all_files)
scoped_stats = _run_scoped_resolver(store) if scoped_changed else None
```

三个细节：其一，`stale_files`/`missing_paths` 并入触发集，保证删除也引发清理（注释里点名了 Spring Event 虚拟边的案例，issue #474）；其二，resolver 返回统计 dict 而不是抛异常，与"非致命"约定呼应；其三，Temporal 复用 `spring_changed`（`.java`）作为触发条件——它是 Spring 生态内的框架，共享 Java 变更信号。

## 为什么不是语言服务器 / 真类型推断

读到这里自然的疑问是：为什么不用 LSP 或 Jedi 这类真类型推断？项目的实际答案可以从它的选择反推：

- **增量成本**：Resolver pass 是对 SQLite 的几条 SQL，秒级完成；语言服务器需要按语言拉起进程、加载项目索引，冷启动以分钟计，与"1 秒防抖后完成更新"的 watch 节拍不兼容；
- **语言矩阵**：40 种语言各接一个语言服务器是不可维护的依赖矩阵，而映射表 + 启发式用统一的低成本覆盖了长尾语言；
- **正确性预算**：代码审查场景需要的是"可能受影响的调用者"的召回，错解析一条边的代价低于漏掉一条边——唯一性约束的启发式在这个目标函数下是合适的精度点；
- **可回退性**：INFERRED 边带 tier 标记，下游随时可以按可信度过滤或降权，推断错了不会污染 EXTRACTED 基线。

`jedi_resolver.py` 的存在说明这条更强的路线被认真试过，最终因上述成本被搁置——这是架构决策的化石证据。

## 小结

Resolver 层是"解析期保真、构建后修补"这一核心模式的具体化。它用一组几十到几百行的、各自独立、幂等且非致命的维护 pass，替代了一个跨 40 种语言的统一类型系统——精度上承认自己是启发式（INFERRED tier、唯一性约束），工程上换来了与解析管线相同的可并行、可增量、可容错性质。读这层代码的正确姿势是把它当成数据库的物化视图维护逻辑，而不是编译器的语义分析。
