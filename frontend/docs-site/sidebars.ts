import type { SidebarsConfig } from '@docusaurus/plugin-content-docs'

const sidebars: SidebarsConfig = {
  primarySidebar: [
    'intro',
    {
      type: 'category',
      label: '画面別ガイド',
      collapsed: false,
      items: [
        'pages/nd2-files',
        'pages/nd2-parser',
        'pages/cell-extraction',
        'pages/database-manager',
        'pages/cell-viewer',
        'pages/annotation',
        'pages/bulk-engine',
        'pages/file-manager',
        'pages/graph-engine',
      ],
    },
    {
      type: 'category',
      label: 'アルゴリズム',
      collapsed: false,
      items: [
        'algorithms/quantitative-methods',
        'algorithms/contour-and-pca',
        'algorithms/centerline-and-length',
        'algorithms/area-and-raw-export',
        'algorithms/fluorescence-vectorization',
        'algorithms/aggregation-scores',
      ],
    },
    {
      type: 'category',
      label: 'コード',
      collapsed: false,
      items: [
        'code/cell-extraction-pipeline',
        'code/bulk-cell-length',
        'code/normalized-median-fitc',
        'code/heatmap-vector-csv',
        'code/graph-engine-hu',
      ],
    },
  ],
}

export default sidebars
