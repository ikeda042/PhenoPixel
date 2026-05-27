import type { Config } from '@docusaurus/types'
import type { Preset } from '@docusaurus/preset-classic'
import path from 'node:path'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'

const config: Config = {
  title: 'PhenoPixel Docs',
  tagline: '顕微鏡画像から細胞を抽出し、単一細胞表現型を解析するためのドキュメント',
  favicon: 'img/images/method-centerline-fit.png',

  url: 'http://localhost:3000',
  baseUrl: '/docs/',
  trailingSlash: true,

  organizationName: 'phenopixel',
  projectName: 'phenopixel6',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'ja',
    locales: ['ja'],
  },

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  themes: ['@docusaurus/theme-mermaid'],

  plugins: [
    function generatedModuleTypePlugin() {
      return {
        name: 'generated-module-type',
        configureWebpack() {
          return {
            module: {
              rules: [
                {
                  test: /\.js$/,
                  include: path.resolve(__dirname, '.docusaurus'),
                  type: 'javascript/auto',
                },
              ],
            },
          }
        },
      }
    },
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          remarkPlugins: [remarkMath],
          rehypePlugins: [rehypeKatex],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/screen-records/cell-extraction.preview.gif',
    navbar: {
      title: 'PhenoPixel',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'primarySidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/pages/cell-extraction/',
          label: 'Cell Extraction',
          position: 'left',
        },
        {
          to: '/pages/bulk-engine/',
          label: 'Bulk Engine',
          position: 'left',
        },
        {
          href: '/',
          label: 'App',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Workflows',
          items: [
            { label: 'ND2 Manager', to: '/pages/nd2-files/' },
            { label: 'Cell Extraction', to: '/pages/cell-extraction/' },
            { label: 'Database Console', to: '/pages/database-manager/' },
            { label: 'Annotation', to: '/pages/annotation/' },
          ],
        },
        {
          title: 'Analysis',
          items: [
            { label: 'Bulk Engine', to: '/pages/bulk-engine/' },
            { label: 'Graph Engine', to: '/pages/graph-engine/' },
            { label: 'Quantitative Methods', to: '/algorithms/quantitative-methods/' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} PhenoPixel.`,
    },
    tableOfContents: {
      minHeadingLevel: 2,
      maxHeadingLevel: 3,
    },
    prism: {
      additionalLanguages: ['bash', 'json', 'python'],
    },
  },
}

export default config
