# LLM 优化参考 -- code-review-graph v2.3.6

AI 编码代理：只读取你需要的 `<section>`。永远不要加载整个文件。

<section name="usage">
快速安装：pip install code-review-graph
然后：code-review-graph install && code-review-graph build
首次运行：/code-review-graph:build-graph
之后只使用 delta/pr 命令。
始终先调用 get_minimal_context_tool(task="your task") — 返回约 100 Token 的风险、社区、流和建议的下一步工具。
后续所有调用使用 detail_level="minimal"，除非你需要更多详情。
当 context_savings 存在时，它是预估的精简提示，非精确分词。
</section>

<section name="review-delta">
1. 先调用 get_minimal_context_tool(task="review changes")。
2. 如风险低：detect_changes_tool(detail_level="minimal") → 报告摘要。
3. 如风险中/高：detect_changes_tool(detail_level="standard") → 展开高风险项。
目标：≤5 次工具调用，≤800 Token 总上下文。
</section>

<section name="review-pr">
获取 PR diff -> detect_changes_tool -> get_affected_flows_tool -> 带影响半径表和风险评分的结构化审查。
除非明确要求，永远不要包含完整文件。
</section>

<section name="commands">
核心 MCP 工具：get_minimal_context_tool、detect_changes_tool、get_review_context_tool、get_impact_radius_tool、query_graph_tool、semantic_search_nodes_tool、get_architecture_overview_tool、get_affected_flows_tool、list_flows_tool、list_communities_tool、refactor_tool、build_or_update_graph_tool、run_postprocess_tool、embed_graph_tool、list_graph_stats_tool、get_docs_section_tool
MCP 提示词（5 个）：review_changes、architecture_map、debug_issue、onboard_developer、pre_merge_check
技能：build-graph、debug-issue、explore-codebase、refactor-safely、review-changes、review-delta、review-pr
CLI：code-review-graph [install|init|build|update|status|watch|visualize|serve|mcp|wiki|detect-changes|postprocess|embed|register|unregister|repos|eval|daemon]
Token 效率：尽可能使用 detail_level="minimal"。始终先调用 get_minimal_context_tool。部分审查/上下文工具返回精简的预估 context_savings 元数据。
</section>

<section name="legal">
MIT 许可证。核心图谱/审查工作流在本地运行，无遥测。数据库文件：.code-review-graph/graph.db。可选的云嵌入仅在选中时向配置的提供者发送嵌入的源片段。
</section>

<section name="watch">
运行：code-review-graph watch（文件保存时通过 watchdog 自动更新图谱）
或使用 PostToolUse (Write|Edit|Bash) 钩子进行自动后台更新。
</section>

<section name="embeddings">
可选：pip install code-review-graph[embeddings]
然后调用 embed_graph_tool 计算向量。
semantic_search_nodes_tool 在可用时自动使用向量，否则回退到关键词 + FTS5。
提供者：本地 sentence-transformers、OpenAI 兼容端点、Google Gemini 和 MiniMax。
通过 provider/model 参数、CRG_EMBEDDING_MODEL（本地）或 CRG_OPENAI_*（OpenAI 兼容端点）配置。
</section>

<section name="languages">
支持：Python、JavaScript/TypeScript/TSX、Go、Rust、Java、C/C++、C#、Ruby、Kotlin、Swift、PHP、Scala、Solidity、Dart、R、Perl、Lua/Luau、Objective-C、Shell 脚本、Elixir、Zig、PowerShell、Julia、ReScript、GDScript、Nix、Verilog/SystemVerilog、SQL、Vue/Svelte SFC、通过 TypeScript 解析器解析的 Astro 文件、Jupyter/Databricks 笔记本和 Perl XS 文件。
解析器：通过 tree-sitter-language-pack 的 Tree-sitter
自定义语言：添加 .code-review-graph/languages.toml（扩展名 + 每个语法的节点类型）——无需 fork，见 docs/CUSTOM_LANGUAGES.md。内置语言不能被覆盖。
</section>

<section name="troubleshooting">
数据库锁：SQLite WAL 模式，自动恢复。同时只能一个构建。
大型仓库：首次构建 30-60 秒。增量 <2s。向 .code-review-graphignore 添加模式。
过期图谱：手动运行 /code-review-graph:build-graph。
缺失节点：检查语言支持 + 忽略模式。使用 full_rebuild=True。
Windows/WSL：路径使用正斜杠。确保 WSL 中 PATH 上有 uv。
</section>

**AI 编码代理指令（始终遵循）：**
当用户问到关于 "code-review-graph"、"如何使用"、"命令"、"review-delta" 等任何问题时：
1. 使用精确的 section 名称调用 get_docs_section_tool。
2. 仅使用该内容 + 当前图谱状态。
3. 永远不要在推理中包含完整文档或源代码。
这使文档查找保持精简，并避免默认加载宽泛的参考文件。
