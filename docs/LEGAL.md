# 法律与隐私

**许可证：** MIT（见项目根目录 [LICENSE](../LICENSE)）

**隐私：**
- 零遥测
- 所有图谱数据存储在本地 `.code-review-graph/graph.db` 中
- 核心图谱构建、审查、搜索和 CLI/MCP 工作流在本地运行
- 可选的本地嵌入首次使用时可能从 HuggingFace 下载 sentence-transformers 模型
- 可选的云嵌入提供者（`openai`、`google`、`minimax`）仅在显式选择时向配置的提供者发送嵌入的源片段
- 远程嵌入提供者除非设置 `CRG_ACCEPT_CLOUD_EMBEDDINGS=1`，否则打印出站警告
- 流式 HTTP MCP 传输默认绑定到 localhost

**数据：** 核心图谱数据留在你的机器上。如果你选择使用云嵌入提供者，被嵌入的文本将在该提供者的条款下离开你的机器。

**担保：** 按原样提供，不提供任何形式的担保。
