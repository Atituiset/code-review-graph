import { defineConfig } from 'vitepress'

// GitHub Pages 项目站点 https://atituiset.github.io/code-review-graph/
const base = '/code-review-graph/'
const repo = 'https://github.com/Atituiset/code-review-graph'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  lang: 'zh-CN',
  title: 'code-review-graph 深入解析',
  titleTemplate: '从原理架构到与 clangd / CSA 的对比',
  description:
    '从原理架构到与 clangd / CSA 的对比——初学者与进阶者双视角学习文档：tree-sitter 代码知识图谱、SQLite 图模型、MCP 上下文裁剪、影响半径与风险评分。',

  base,
  lastUpdated: true,
  cleanUrls: true,
  srcExclude: ['README.md'],

  markdown: {
    // shiki 3.x 不再内置 cuda 语法, 用 cpp 高亮兜底
    languageAlias: { cuda: 'cpp' },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#2e7d5b', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#18191c', media: '(prefers-color-scheme: dark)' }],
    ['meta', { property: 'og:title', content: 'code-review-graph 深入解析' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          '从原理架构到与 clangd / CSA 的对比——初学者与进阶者双视角学习文档：tree-sitter 代码知识图谱、SQLite 图模型、MCP 上下文裁剪。',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    // 学习笔记悬浮组件（localStorage），VitePress SPA 路由切换由 theme/index.ts 通知其重挂载
    ['script', { src: `${base}notes.js` }],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/favicon.svg',

    nav: [
      { text: '首页', link: '/' },
      { text: '初学者篇', link: '/beginner/what-why' },
      { text: '进阶篇', link: '/advanced/architecture' },
      { text: '对比篇', link: '/compare/vs-clangd-csa' },
    ],

    sidebar: [
      {
        text: '初学者篇',
        collapsed: false,
        items: [
          { text: '这个项目是什么、解决什么问题', link: '/beginner/what-why' },
          { text: '快速上手', link: '/beginner/quickstart' },
          { text: '核心概念：图、流、社区', link: '/beginner/concepts' },
          { text: '常见工作流', link: '/beginner/workflows' },
        ],
      },
      {
        text: '进阶篇',
        collapsed: false,
        items: [
          { text: '架构总览：四阶段管线', link: '/advanced/architecture' },
          { text: '解析与存储：tree-sitter、SQLite 图模型、增量更新', link: '/advanced/pipeline' },
          { text: '语言与框架语义层：从语法抽取到框架约定', link: '/advanced/language-semantics' },
          { text: '语义解析层：Resolver 机制', link: '/advanced/resolvers' },
          { text: '查询引擎：影响半径、流、社区与风险评分', link: '/advanced/query-engine' },
          { text: '可信度报告：空结果为什么不等于"不存在"', link: '/advanced/uncertainty' },
          { text: 'Token 经济：为 LLM 设计的上下文预算', link: '/advanced/token-economy' },
          { text: '守护进程与 watch：长时运行的可靠性工程', link: '/advanced/daemon-watch' },
        ],
      },
      {
        text: '对比篇',
        collapsed: false,
        items: [
          { text: '与 clangd / CSA 的本质区别', link: '/compare/vs-clangd-csa' },
          { text: '与 mcp-language-server 的对比（LSP 代理路线）', link: '/compare/vs-mcp-language-server' },
          { text: '优点、不足与适用场景', link: '/compare/pros-cons' },
        ],
      },
    ],

    outline: {
      level: [2, 3],
      label: '本页大纲',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    editLink: {
      pattern: 'https://github.com/Atituiset/code-review-graph/edit/main/docs-vitepress/:path',
      text: '在 GitHub 上编辑此页',
    },

    socialLinks: [{ icon: 'github', link: repo }],

    docFooter: { prev: '上一页', next: '下一页' },

    lastUpdated: {
      text: '最后更新于',
      formatOptions: { dateStyle: 'short', timeStyle: 'short' },
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    skipToContentLabel: '跳转到内容',

    footer: {
      message: '基于 MIT 许可发布',
      copyright: 'Copyright © 2026 code-review-graph 深入解析',
    },
  },
})
