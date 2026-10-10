---
layout: home

hero:
  name: code-review-graph
  text: 深入解析
  tagline: 基于 v2.3.8 源码逐行分析的学习文档——本地优先的代码知识图谱：tree-sitter 解析成图、SQLite 持久化、MCP 按 token 预算裁剪上下文
  actions:
    - theme: brand
      text: 开始阅读
      link: /beginner/what-why
    - theme: alt
      text: 架构总览
      link: /advanced/architecture
    - theme: alt
      text: GitHub
      link: https://github.com/Atituiset/code-review-graph

features:
  - title: 初学者篇
    details: 不需要编译原理背景。从"解决什么问题"讲起，到装起来、用起来、看懂图 / 流 / 社区等基本概念与常见工作流。
    link: /beginner/what-why
  - title: 进阶篇
    details: 深入每个子系统的实现细节：四阶段管线、tree-sitter 与 SQLite 图模型、Resolver、查询引擎、Token 经济、守护进程，附源码位置可对照阅读。
    link: /advanced/architecture
  - title: 对比篇
    details: 与 clangd / CSA、以及 mcp-language-server（LSP 代理路线）的本质区别，各自的优点、不足与适用场景。
    link: /compare/vs-clangd-csa
---
