# 路线图

## 已发布

### v2.3.6
- **无需 fork 即可自定义语言**：`.code-review-graph/languages.toml` 将扩展名和节点类型映射到任意 tree-sitter-language-pack 语法（`docs/CUSTOM_LANGUAGES.md`）
- **GitHub Action** 用于风险评分 PR 审查评论：在 CI 运行器上构建/恢复图谱，每次推送更新置顶评论，可选 `fail-on-risk` 合并门控；通过 `.github/workflows/pr-review.yml` 自行验证（`docs/GITHUB_ACTION.md`）
- **`agent_baseline` 基准**：图谱查询与现实的 grep-and-read-top-k 代理基线对比，已接入所有六个固定评估配置
- `impact_accuracy` 的**协同变更真值**；旧图谱推导指标标注为循环上限
- **每周评估 CI**：两个最小配置的仅报告定时运行（`.github/workflows/eval.yml`）
- **`docs/FAQ.md`**：与 LSP、RAG、grep/代理搜索和相邻工具的对比，以及何时不用指南
- **贡献脚手架**：issue 表单、PR 模板、dependabot 配置
- **Windows 修复**：`daemon status`（#511）和 `detect-changes` 路径映射（#528）
- **可靠性**：嵌入提供者名称验证、分析/wiki 工具中的 SQLite 存储泄漏修复、`fastmcp<4` 上限、通过 `git rev-parse --git-path hooks` 安装钩子

### v2.3.5
- `detect-changes --brief` 和新 `update --brief` 上的 **Token Savings 面板** —— 带框 CLI 输出，按类别细目总和精确等于图谱响应大小
- **`--verify` 标志** 与 OpenAI 的 `cl100k_base` 分词器交叉核对显示的节省；`docs/REPRODUCING.md` 中提交的校准数据显示预估与真实 GPT-4 Token 总量偏差约 ~1%
- **`code-review-graph embed`** CLI 子命令用于显式嵌入生成
- **确定性评估管道**：每个配置固定上游 SHA，完整克隆加 `returncode` 检查，固定种子的 Leiden 社区检测（`CRG_LEIDEN_SEED`）
- **`multi_hop_retrieval` 基准**：11 个策划的 2 步工具链任务；平均得分 0.909
- **更丰富嵌入文本** 和**标识符感知搜索增强** 将多跳准确度从 0.545 提升到 0.909
- 评估管道中的**路径规范化修复** + 简要摘要中的测试缺口去重
- **`docs/REPRODUCING.md`**：端到端配方，含标准数字和 tiktoken 校准表
- 演示 GIF（`diagrams/context-savings-demo.gif`）展示两个 CLI 界面和 `--verify`

### v2.3.4
- 30 个 MCP 工具和 5 个 MCP 提示词
- 审查、影响、检测变更和精简架构响应的预估 Token 节省元数据
- 默认精简架构概览以减少大型 MCP 负载
- 大型 diff 的有界变更分析控制（`CRG_MAX_CHANGED_FUNCS`、`CRG_MAX_TRANSITIVE_FRONTIER`、`CRG_TOOL_TIMEOUT`）
- Windows FastMCP 语义搜索死锁缓解
- Rust 测试检测和路径查找正确性修复
- 2.3.4 版本的文档和版本元数据刷新

### v2.3.3
- 跨源语言、Shell 脚本、笔记本和 SFC 风格文件的广泛解析器扩展
- 额外的 AI 编码平台安装目标，包括 Gemini CLI、Qwen、Kiro、Qoder 和 GitHub Copilot 变体
- 流式 HTTP MCP 传输在 localhost
- 解析器/解析器、Windows、FastMCP 和守护进程可靠性修复
- 社区 PR 清理和 VS Code 可访问性改进

### v2.2.0
- 多仓库监视守护进程（`crg-daemon` / `code-review-graph daemon`）
- 基于 TOML 的守护进程配置（`~/.code-review-graph/watch.toml`）
- 子进程管理：每个仓库一个 `code-review-graph watch` 进程
- 配置文件监视，自动协调监视进程
- 带有 PID 文件管理的守护进程化
- 健康检查，自动重启死掉的监视器
- 独立 `crg-daemon` CLI 入口点（7 个子命令）
- 主 CLI 中集成的 `daemon` 子命令组

### v2.0.0
- 22 个 MCP 工具（从 9 个增加）和 5 个 MCP 提示词
- 18 种语言（新增 Dart、R、Perl）
- 带关键性评分的执行流检测
- 社区检测（通过 igraph 的 Leiden 算法，基于文件回退）
- 带耦合警告的架构概览
- 风险评分变更检测（`detect_changes`）
- 重构工具（重命名预览、死代码、建议）
- 从社区结构生成 Wiki
- 带跨仓库搜索的多仓库注册表
- 带 Porter 词干提取的 FTS5 全文搜索
- 数据库迁移（v1-v5）
- 带 matplotlib 可视化的评估框架
- TypeScript tsconfig 路径别名解析
- MiniMax 嵌入提供者（embo-01）
- 可选依赖组：`[embeddings]`、`[google-embeddings]`、`[communities]`、`[eval]`、`[wiki]`、`[all]`
- 22 个测试文件中的 486 个测试

### v1.8.4
- 多词 AND 搜索、调用目标解析、影响半径分页
- `find_large_functions_tool`、Vue SFC 和 Solidity 支持
- 文档刷新

### v1.7.0
- `install` 命令作为主入口（`init` 保留为别名）
- 用于预览安装/初始化变更的 `--dry-run` 标志
- 通过 GitHub Actions 在发布时自动 PyPI 发布
- 使用来自 httpx、FastAPI 和 Next.js 的真实基准数据重写 README

### v1.6.x
- 可移植的 `uvx` 核心 MCP 配置
- 自动图谱工具偏好的 SessionStart 钩子
- 24 个审计修复：C/C++ 支持、性能、CI 加固

### v1.5.x
- `.code-review-graph/` 目录中的生成文件
- 可视化密度：折叠启动、搜索、边切换
- 无需 git 即可工作

### v1.4.0
- `init` 命令、交互式 D3.js 可视化、`serve` 命令

### v1.3.0
- 通用 pip 安装、CLI 入口点、Python 版本检查

### v1.1.0-v1.2.0
- Watch 模式、向量嵌入、日志、CI 覆盖

### v1.0.0（基础版本）
- 持久化 SQLite 知识图谱、Tree-sitter 解析、增量更新
- 影响半径分析、6 个 MCP 工具、3 个技能

## 计划中

- GitHub App / bot 模式，超越当前 GitHub Action（组织级安装、check run）
- 团队同步（通过 git 跟踪 DB 共享图谱）
- Monorepo 性能优化（>50k 文件）

## 进行中

- 按需添加额外语言语法
- 随 AI 编码平台演进的集成更新
