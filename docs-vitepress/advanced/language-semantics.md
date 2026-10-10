# 语言与框架语义层：从语法抽取到框架约定

第 2 章讲了"怎么把语法抽成图"。本章讲图里那些**语法层面根本不存在**的东西：HTTP 端点、依赖注入、Kafka 主题、Terraform 模块引用——以及为了把它们抽出来，parser 里长出的第二套体系。最后用一次真实的、横跨 8 个提交的解析器修复（Go receiver 解析链）做案例研究，看这套体系如何演进。

## 语言判定：一棵决策树，不是一张查找表

第 2 章说语言判定是"先扩展名、后 shebang"，实际完整流程有更多分支（`parse_bytes` 入口，parser.py:2485-2519）：

```
读字节（同一份字节贯穿哈希/探测/解析，防 TOCTOU）
  │
  ├─ 扩展名 → EXTENSION_TO_LANGUAGE（parser.py:715-785，62 个扩展名）
  │     │
  │     ├─ .blade.php ────────────→ blade 伪语言
  │     ├─ .yml/.yaml + Ansible 路径约定 → ansible 伪语言（还要过内容门，见下文）
  │     ├─ properties/yaml + Spring 配置路径 → spring_config（config_keys.py:8-16 的正则）
  │     ├─ 普通 .properties（非 Spring）→ None，跳过
  │     └─ 其余 → 39 个内建语言标签之一
  │
  ├─ 无扩展名 → 读头部 256 字节探测 shebang（SHEBANG_INTERPRETER_TO_LANGUAGE，parser.py:821-844）
  │
  └─ .h 特例：默认按 C 解析；若掩掉 Qt 宏后发现 C++ 独有语法证据
        （namespace/template/class 等 _CPP_HEADER_EVIDENCE_TYPES，parser.py:791-803），
        用 cpp grammar 重解析（_has_cpp_header_evidence，parser.py:2794）
```

三个值得注意的设计：

- **Ansible 有双重大门**：先要路径约定命中（`playbooks/`/`roles/`/`tasks/` 等目录成分或 `site.yml` 类命名），再要内容证据命中（顶层是 YAML 列表且含 `hosts:`/`tasks:` 或已知模块名）。只有目录名没有内容证据的普通 YAML 仓库不会被误吞（`_is_ansible_path` / `_is_ansible_content`，parser.py:2296-2329）。一个"看起来像 Ansible 目录"的 CI 配置仓库因此安然无恙；
- **Spring 配置文件会拒绝冒名顶替者**：`_is_non_spring_yaml`（parser.py:5674-5697)按顶层键签名识别 Kubernetes manifest、GitHub Actions workflow、OpenAPI spec、CloudFormation 模板并拒绝解析——它们都是 YAML，但不是配置属性；
- **`.h` 的 C/C++ 判别靠证据而非猜测**：C++ 证据不足就保持 C 解析，宁可少抽也不把 C 头文件当 C++ 撕开。

## 框架语义层：虚拟节点与派生边

核心节点类型（`File`/`Class`/`Function`/`Test`/`Type`）之外，框架特化还产出四种节点和一族边。它们共同的特点是**在源码里没有一个叫这个名字的声明**——它们是框架约定的物化。

### 节点动物园

| 节点类型 | 来源 | 例子 |
|---|---|---|
| `Endpoint` | Spring MVC 注解 / WebFlux 函数式路由 | `GET /api/users` |
| `ConfigProperty` | `application.{yml,properties}` 的键 | `spring.datasource.url` |
| `Scheduler` | `@Scheduled` 方法 | cron 触发器 |
| `Event`（虚拟） | `event_resolver.py:76` 合成，`file_path="event"` 哨兵值 | `OrderCreatedEvent` |

### 边动物园

| 边类型 | 语义 | 典型来源 |
|---|---|---|
| `HANDLES` | handler 方法 → Endpoint / 事件监听 | `@GetMapping`、`@EventListener` |
| `TRIGGERS` | Scheduler → 方法 | `@Scheduled(cron=...)` |
| `INJECTS` | 字段/构造器注入 | `@Autowired`、Lombok |
| `PUBLISHES` | 发布者 → `event::<Type>` | `publishEvent(new X())` |
| `CONSUMES` / `PRODUCES` | 消费者/生产者 → `kafka:<topic>` | `@KafkaListener`、`KafkaTemplate.send` |
| `DEPENDS_ON_CONFIG` | Bean → ConfigProperty | `@ConfigurationProperties` 绑定 |
| `TEMPORAL_STUB` | 字段 → workflow/activity 接口 stub | Temporal SDK 惯用法 |

这些边全部带 `extra` 元数据（http_method、route、kafka_type、event_type……），且都汇入同一个查询模型：`query_graph_tool` 的 `triggers_of`/`triggered_by`/`publishers_of`/`listeners_of`/`handlers_of`/`endpoints_for`/`consumers_of` 等 pattern 就是按它们建的。"这个接口被哪些 HTTP 端点触达"从此是一条 SQL，而不是一次全仓 grep。

### Spring：覆盖最深的框架

Spring 特化（常量集中定义在 parser.py:1280-1323）值得单独展开，因为它处理的问题在所有 IoC 框架里有共性：

- **路由拼接有个巧劲**：类级 `@RequestMapping("/api")` + 方法级 `@GetMapping("/users")` 需要拼成完整路由，但 AST 遍历是自顶向下的单遍——类前缀先于方法体到达，方法抽取时类上下文已丢失。解法是把前缀暂存进 `import_map["__crg_spring_request_prefix__:<Class>"]`（写入 parser.py:10212-10222，读取 parser.py:9341-9353）：借用现成的 import 表当作用域间的便签纸，不为一个特性加一条数据通道；
- **WebFlux 函数式路由**没有注解可找：`route(GET("/users"), handler::all)` 是流畅调用链。检测以 import 为门（必须引入 `org.springframework.web.reactive.function.server`），再沿 `RouterFunction` 调用链找 handler 方法引用（`_emit_spring_webflux_endpoint`，parser.py:9502-9577），避免把普通 builder 链误判成路由；
- **ConfigProperty 刻意丢弃值**：只入库键名和结构，值一律不存——配置文件里的密码和密钥不会流进图、不会出现在任何 MCP 响应里（CHANGELOG 明确记录了这一取舍："value-redacted"）。这是安全边界画在解析层的例子；
- **Lombok 注入语义被精确建模**：`@AllArgsConstructor` 下所有字段注入；`@RequiredArgsConstructor` 下只有 `final` 或 `@NonNull` 且**无初始化器**的字段注入（parser.py:9095-9168）。语义错了 INJECTS 边就错，下游 spring_resolver 的"唯一实现"推理跟着全错；
- **Kafka 主题是一等公民**：`@KafkaListener(topics = "orders")` 产生 `CONSUMES → kafka:topic:orders` 边，生产端模板类型（KafkaTemplate/ReactiveKafkaProducerTemplate 等）产生 `PRODUCES`，消息类型取泛型最后一个参数（parser.py:9875-10032）。主题解析不出时落到哨兵目标 `kafka:config`——边还在（说明这里有 Kafka 交互），只是粒度粗。

### Laravel 与 Terraform：两种"跨文件缝合"

PHP/Laravel（`_extract_php_laravel_edges`，parser.py:11355 起）与 Terraform/HCL 解决的是同一类问题——**框架把调用关系藏进了字符串或配置**——但手法相反：

- **Laravel 在解析期内联缝合**：`Route::get('/users', [UserController::class, 'index'])` 的 controller 引用在同一个 AST 里就能经 namespace + use 导入解析，当场发出 routes 文件 → controller 方法的 CALLS 边（`_emit_laravel_route_edge`，parser.py:11735）；Eloquent 关系（`hasMany(Model::class)`）变成带 `laravel_kind` 的 REFERENCES 边；
- **Terraform 靠构建后 resolver 缝合**：`.tf` 文件互相引用资源（`module.x.output`），但 tree-sitter 解析是文件本地的。`hcl_resolver.py:15` 的 pass 只在**同目录内该名字唯一**时重写占位目标，本地 module `source = "./vpc"` 则解析为真实文件路径的 IMPORTS_FROM（优先 `main.tf`）。又是唯一性原则。

## TESTED_BY：镜像边的取向设计

测试覆盖是风险评分的关键因子，而它的载体是一条**方向刻意反着存**的边：解析期发现 CALLS 边的 source 是测试函数时，镜像一条 `TESTED_BY` 边，source=生产符号、target=测试（parser.py:2772-2789）。反向存储让"改了这个函数，哪些测试受影响"成为顺流传播（第 5 章方向表里 TESTED_BY 是唯一的顺流边），与影响半径共用同一套传播机制。

JS/TS 生态还有个补丁：`describe/it/test` 调用的回调函数没有名字，会被注册成合成 Test 节点，命名格式 `"<runner>:<description>@L<line>"`（parser.py:10693-10745）——`it("rejects expired tokens")` 从此是图上可寻址的节点。

## 案例研究：Go receiver 解析链（PR #830/#833/#868，8 个提交）

这是观察本项目工程方法论的最佳标本。问题看似简单：

```go
func (s *Store) Get(id string) (*Row, error) { return s.query(id) }
func (s *Store) query(id string) (*Row, error) { ... }
```

`s.query(id)` 在 tree-sitter 眼里是"对名为 s 的 receiver 调用名为 query 的方法"——裸调用，不知道属于哪个类型。 naive 的修法是"看到方法体内的 `s.xxx()` 就绑定到本方法的 receiver 类型"。但这个修法是错的，错误来自遮蔽（shadowing）：

```go
func (s *Store) M() {
    s.helper()          // 这里的 s 是 Store —— 应绑定
    f := func(s *Cache) {
        s.get()         // 这里的 s 是 Cache —— 绑定到 Store 就错了
    }
    for _, s := range items {
        s.use()         // range 子句重新绑定了 s —— 又不一样
    }
}
```

最终的修复链条分四步，每步一个提交：

1. **receiver 类型抽取**（`_get_go_receiver_type`，parser.go 对应 parser.py:14782-14804）：从 `func (s *T)` 抽出 T，解开 `*T` 指针和 `T[P]` 泛型包装；方法节点记 `extra.go_receiver`；
2. **合并式遮蔽图预计算**（`_go_receiver_binding_index`，parser.py:14870-14976）：对每个方法体预计算一份"字节区间 → 变量绑定"的合并映射，覆盖闭包参数、`:=` 短声明（含 `for` init 子句的作用域父级）、range 子句、channel receive 语句、type switch 别名、const/var/type 规格。查询用二分（`_go_receiver_is_shadowed`，parser.py:14979）；
3. **保守的证据标记**（调用点，parser.py:10776-10795）：仅当调用 receiver 名 == 本方法的 receiver 名**且未被遮蔽**时，才标 `extra.go_method_receiver=True`。任何疑虑都不标记——错绑定的边会污染 flow 和影响半径，漏标记只是缺边；
4. **同文件唯一候选绑定**（`_resolve_call_targets` 的 Go 分支，parser.py:4708-4756）：有证据的调用绑定到同文件、同 parent 作用域的唯一同名方法。不唯一就不绑。

这个案例浓缩了全书反复出现的三条原则：**证据持久化**（解析期只存事实，绑定推迟）、**唯一性约束**（宁缺勿错）、**保守降级**（不确定就保持裸名）。也展示了这类项目的真实成本分布——"支持 Go 方法调用"不是一行映射表，而是八次提交的遮蔽语义考古。

## 近期解析器修复速览

v2.3.7→v2.3.8 周期的其他修复，每条都是一个被图放大过的微妙 bug：

| 问题 | 根因 | 后果（修复前） | 位置 |
|---|---|---|---|
| Swift 构造器/析构器/subscript 不是节点 | grammar 节点名与 function_declaration 不同，walker 跳过 | 函数体调用被归给整个 File 节点，爆炸半径虚胖；init 无法反查调用者 | parser.py:1017-1022、14632-14651（#786） |
| C# 方法被命名为返回类型 | `public async Task Foo()` 取首个 identifier | 同类所有此类方法坍缩到一个 qualified name | #791 |
| Java 方法取错名字 | 遍历找第一个 identifier 子节点 | 同上，改为读 grammar `name` 字段（对齐 C#） | #804 |
| Kotlin import 后跟注释 | tree-sitter-kotlin 把尾随注释折进 import 节点 | 整段注释被当成模块名，后续 stat 触发 ENAMETOOLONG，整个文件失败 | `_extract_import` Kotlin 分支（#824） |
| NestJS 相对导入断链 | `Path.with_suffix()` **替换**末尾后缀：`./outlet.entity` 探测 `outlet.ts` 而非 `outlet.entity.ts` | 所有 `*.entity.ts`/`*.service.ts` 约定的导入静默丢失 | parser.py:13661-13672（#845） |
| SQL 幻影表 | `IF NOT EXISTS` 关键词泄进 FROM/JOIN 扫描 | 不存在的表出现在 REFERENCES 里 | `_SQL_TABLE_RE`（#838） |
| CommonJS require 断链 | 只有 ESM static import 被解析 | `const x = require("./mod")` 无 IMPORTS_FROM | `_js_static_module_target`（parser.py:13301） |
| jsconfig 项目别名失效 | 只认 tsconfig.json | 纯 JS 的 Vue/Nuxt/Vite 项目丢大半导入图 | tsconfig_resolver `_TSCONFIG_NAMES`（#776） |

两个模式值得注意。其一，多数 bug 的症状不是崩溃而是**静默缺边**——这正是第 6 章（可信度报告）存在的原因：图自己知道哪类缺口是已知静态分析盲区，空结果时会明说。其二，修复几乎都落在"读取证据的方式"上，而不是新增机制——`name` 字段本来就在 AST 里，`outlet.entity.ts` 本来就在磁盘上。这套体系的日常维护成本不在架构，在对每门语言细节的持续校准。

## 已知局限

如实列出本章体系的边界：

- **框架覆盖是策展的，不是通用的**：HTTP 端点边是 Spring-only（MVC 注解 + WebFlux 函数式）；Express/FastAPI/Flask 的路由注册不产生 Endpoint 节点。uncertainty 层的 gap 提示明确承认这一点（"endpoint edges are spring-only"）；
- **`OVERRIDES` 边不存在**：它出现在影响半径权重表里（constants.py:60），但 parser 从不发射——重写关系目前只能经 INHERITS 间接表达。权重表里这是个死条目；
- **虚拟 Event 节点是全局重建的**：任何 Java 变更触发整表删除重建（event_resolver 的 rebuild 式幂等），超大 Java 仓库上这是增量更新的隐藏成本项；
- **Ansible/Spring 配置的内容门是启发式**：极端情况下（比如用 Spring 配置风格写的非 Spring YAML）可能误判，尽管签名拒绝已经挡掉了最常见的四种假阳性。

## 小结

框架语义层回答的问题是：当调用关系不再表现为函数调用语法时，怎么让它仍然进图。答案是用一套虚拟节点 + 派生边把框架约定翻译成图结构，翻译过程遵守与语法抽取相同的纪律（证据持久化、唯一性、显式截断），并且同样诚实——覆盖不到的地方，由第 6 章的可信度报告向调用方坦白。
