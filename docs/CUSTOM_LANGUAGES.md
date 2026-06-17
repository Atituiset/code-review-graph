# 自定义语言（自带语言）

code-review-graph 内置 30+ 种语言的解析器，但它依赖的 [tree-sitter-language-pack](https://github.com/Goldziher/tree-sitter-language-pack) 捆绑的语法远多于内置列表。如果你的仓库使用图谱尚未覆盖的语言——Erlang、Haskell、OCaml、Fortran、Ada、Clojure 等——你可以通过一个小配置文件教解析器认识它。无需 fork，无需代码变更。

## 快速开始

创建 `<repo_root>/.code-review-graph/languages.toml`：

```toml
[languages.erlang]
extensions = [".erl"]
grammar = "erlang"
function_node_types = ["function_clause"]
class_node_types = ["record_decl"]
import_node_types = ["import_attribute"]
call_node_types = ["call"]
comment = "Erlang via the bundled tree-sitter-erlang grammar"
```

然后重建：

```bash
uv run code-review-graph build
```

匹配配置扩展名的文件现在会使用指定的语法解析，生成的 Function/Class 节点和 CALLS/IMPORTS_FROM 边会流经每个下游功能（影响半径、搜索、社区、Wiki、MCP 工具），与内置语言完全相同。节点带有自定义语言名称（此处 `erlang`）的 `language` 字段。

## Schema 参考

每个自定义语言是一个 `[languages.<name>]` 表。

| 键 | 类型 | 必需 | 含义 |
|----|------|------|------|
| `<name>` | 表键 | 是 | 语言标识符，存储在每个解析节点上。小写字母、数字、`_`、`-`；最多 32 字符；必须以字母开头。 |
| `extensions` | 字符串列表 | 是 | 要认领的文件扩展名，每个以点开头（如 `".erl"`）。不区分大小写匹配。 |
| `grammar` | 字符串 | 是 | `tree_sitter_language_pack` 提供的语法名称（探测可用性——见下文）。 |
| `function_node_types` | 字符串列表 | 否* | 定义函数/方法的 Tree-sitter 节点类型。匹配的节点变为 `Function` 节点（名称/文件看起来像测试时变为 `Test` 节点）。 |
| `class_node_types` | 字符串列表 | 否* | 定义类/记录/类型的节点类型。匹配的节点变为 `Class` 节点。 |
| `import_node_types` | 字符串列表 | 否* | import/include 语句的节点类型。每个生成 `IMPORTS_FROM` 边。 |
| `call_node_types` | 字符串列表 | 否* | 调用表达式的节点类型。每个从封闭函数生成 `CALLS` 边。 |
| `comment` | 字符串 | 否 | 给人类的自由格式注释；解析器忽略。 |

\* 四个节点类型列表中至少一个必须非空，否则跳过该条目（没有可提取的内容）。

### 验证规则（安全优先）

加载器不会导致构建崩溃。任何无效项都会跳过并记录 `WARNING` 日志行：

- **内置语言始终优先。** 自定义语言不能认领内置扩展名（`.py`、`.ts`、`.ex` 等），也不能复用内置语言名称（`python`、`elixir` 等）。
- `grammar` 必须能从 `tree_sitter_language_pack` 加载；未知语法被跳过。
- 每个扩展名必须以点开头。
- 两个自定义语言不能认领同一扩展名（先到先得）。
- 每个 repo 最多加载 **20** 个自定义语言。
- 格式错误的 TOML 会禁用该构建的自定义语言（带警告）。

## 查找正确的节点类型名称

节点类型名称是语法特定的，所以你需要查看语法实际生成的树。两个简单选项：

**选项 1 — tree-sitter playground。** 将代码片段粘贴到 <https://tree-sitter.github.io/tree-sitter/7-playground.html> 并从解析树中读取节点名称（先选择匹配的语法）。

**选项 2 — 本地 Python 探测。** 你的构建使用的确切语法版本就是 `tree_sitter_language_pack` 中的版本，因此本地探测是最可靠的真实来源：

```bash
uv run python - <<'EOF'
import tree_sitter_language_pack as tslp

source = b"""
-module(math_utils).
add(A, B) -> helper(A) + B.
helper(X) -> X * 2.
"""

def dump(node, depth=0):
    print("  " * depth + node.type, node.text.decode()[:40].replace("\n", " "))
    for child in node.children:
        dump(child, depth + 1)

dump(tslp.get_parser("erlang").parse(source).root_node)
EOF
```

选择包裹整个定义的节点类型（`function_clause`，而非内部 `atom`）和整个调用表达式（`call`，而非被调用者标识符）。

## 完整示例：Erlang 端到端

`src/math_utils.erl`：

```erlang
-module(math_utils).
-export([add/2, scale/2]).
-import(lists, [map/2]).

-record(point, {x, y}).

add(A, B) ->
    helper(A) + B.

helper(X) -> X * 2.

scale(Points, F) ->
    lists:map(fun(P) -> add(P, F) end, Points).
```

使用快速开始中的 `[languages.erlang]` 配置，构建会产生：

- 来自 `function_clause` 的 `Function` 节点 `add`、`helper`、`scale`，每个带有 `language = "erlang"`。
- 来自 `record_decl` 的 `Class` 节点 `point`。
- `CALLS` 边 `add → helper` 和 `scale → add`，解析为同文件限定名，加上远程调用的 `scale → lists:map`。
- 来自 `import_attribute` 的 `IMPORTS_FROM` 边，目标为 `lists`。
- 文件到每个定义的 `CONTAINS` 边。

## 提取的工作原理（及其限制）

自定义语言使用与内置语言相同的通用 tree-sitter 遍历器——没有需要维护的每语言代码路径。这保持了功能简单，但通用启发式有限制：

- **名称提取使用默认的名称字段启发式。** 遍历器查找常见标识符类型（`identifier`、`name`、`type_identifier` 等）的子节点，并回退到语法的 `name` 字段（`node.child_by_field_name("name")`）。将定义名称存储在另一种形态中（例如嵌套两层，使用非标准字段）的语法会产生未命名——因而被跳过——的定义。
- **被调用者提取探测常见字段名**（`function`、`callee`、`expr`、`name`）并下沉到柯里化应用。异类的调用形态可能被遗漏。
- **导入目标**来自语法的 `module`/`name`/`path`/`source` 字段（如果存在），否则记录原始语句文本。
- **无跨文件模块解析。** 导入边保持写入的模块名称（如 `lists`）；不会像有专用解析器的内置语言那样解析为文件路径。
- **无语言特定的扩展**：诸如基于装饰器的测试检测、框架注解（Spring、Temporal）或 SFC 处理等只存在于内置语言中。

如果一种语言需要比通用遍历器更深入的支持，请提交 issue——配置驱动的支持是入口，而非上限。

## 故障排查

- 使用 `-v`/日志运行构建并查找 `languages.toml` 警告——每个跳过的条目都会说明具体原因。
- 探测语法可用性：
  `uv run python -c "import tree_sitter_language_pack as t; t.get_language('erlang')"`
  （如果语法未捆绑则引发 `LookupError`）。
- 配置在构造解析器时读取（每次 `build`/`update`），因此配置变更在下一次构建时生效——编辑后重新运行 `uv run code-review-graph build`。
