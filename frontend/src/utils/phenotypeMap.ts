export const localizationMetrics = [
  { key: 'entropy_norm', label: 'Intensity entropy', unit: '', description: '0: one bright pixel; 1: uniform intensity across cell pixels. Measures concentration, independent of where the bright pixels lie.' },
  { key: 'hoyer_sparsity', label: 'Hoyer sparsity', unit: '', description: '0: uniform intensity; 1: signal concentrated in one pixel.' },
  { key: 'top10_fraction', label: 'Top 10% signal fraction', unit: '', description: 'Fraction of total signal in the brightest ceil(10% of cell pixels). Higher values indicate stronger concentration.' },
  { key: 'polar_enrichment', label: 'Polar enrichment', unit: '×', description: 'Mean signal in the two terminal 20% regions / mean signal across the cell. Uniform signal = 1.' },
  { key: 'midcell_enrichment', label: 'Midcell enrichment', unit: '×', description: 'Mean signal in the central 40–60% region / mean signal across the cell. Uniform signal = 1.' },
  { key: 'axial_spread', label: 'Relative axial spread', unit: '', description: 'Signal-weighted standard deviation of normalized centerline position (0–0.5). A tight spot has a small spread; signals at both poles have a large spread.' },
  { key: 'axial_offset', label: 'Axial centroid offset', unit: '', description: 'Twice the absolute displacement of the signal centroid from midcell: 0 at the center, 1 at a pole. It does not identify the old or new pole.' },
  { key: 'axial_asymmetry', label: 'Axial asymmetry', unit: '', description: 'Absolute difference between mean signal in the two halves / their sum. 0: balanced halves; 1: signal in one half only.' },
] as const

export const phenotypeMetrics = [
  ...localizationMetrics,
  { key: 'normalized_median', label: 'Normalized median (raw)', unit: '', description: 'Median intracellular raw intensity / maximum raw intensity; uses the saved image before the selected background correction.' },
  { key: 'length_px', label: 'Cell length', unit: 'px', description: 'PCA major-axis extent of the cell in pixels.' },
  { key: 'width_mean_px', label: 'Mean full width', unit: 'px', description: 'Twice the mean shortest contour-to-centerline distance.' },
  { key: 'width_median_px', label: 'Median full width', unit: 'px', description: 'Twice the median shortest contour-to-centerline distance.' },
  { key: 'area_px2', label: 'Cell area', unit: 'px²', description: 'Stored contour area in pixels squared.' },
] as const

export type MetricKey = typeof phenotypeMetrics[number]['key']
export type FluoChannel = 'fluo1' | 'fluo2'
export type BackgroundMode = 'local_ring' | 'none'
const shapeKeys = ['length_px', 'width_mean_px', 'width_median_px', 'area_px2'] as const
type ShapeKey = typeof shapeKeys[number]
type FluorescenceKey = typeof localizationMetrics[number]['key'] | 'normalized_median' | 'background_intensity'
export type PhenotypeCell = {
  cell_id: string
  manual_label: string
} & Record<ShapeKey | `${FluoChannel}_${FluorescenceKey}`, number | null>
export type PhenotypeFeatures = {
  dbname: string
  feature_version: string
  source_fingerprint: string
  degree: number
  units: Record<string, string>
  localization: Record<string, string | number>
  cells: PhenotypeCell[]
}
export type Bounds = { xMin: number; xMax: number; yMin: number; yMax: number }

export const isShapeMetric = (key: MetricKey): key is ShapeKey => shapeKeys.some((shape) => shape === key)

export const metricValue = (cell: PhenotypeCell, key: MetricKey, channel: FluoChannel) => {
  const value = isShapeMetric(key) ? cell[key] : cell[`${channel}_${key}`]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const metricLabel = (key: MetricKey, channel: FluoChannel) => {
  const metric = phenotypeMetrics.find((item) => item.key === key)!
  return `${isShapeMetric(key) ? '' : `${channel.toUpperCase()} `}${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`
}

export const metricDescription = (key: MetricKey) => phenotypeMetrics.find((item) => item.key === key)!.description

export const featureKeys = [
  ...shapeKeys,
  ...(['fluo1', 'fluo2'] as const).flatMap((channel) =>
    (['normalized_median', ...localizationMetrics.map(({ key }) => key), 'background_intensity'] as const)
      .map((key) => `${channel}_${key}` as const)),
]

export function parsePhenotypeFeatures(payload: unknown): PhenotypeFeatures {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid phenotype response.')
  const data = payload as PhenotypeFeatures
  if (!Array.isArray(data.cells) || typeof data.dbname !== 'string' ||
      typeof data.feature_version !== 'string' || typeof data.source_fingerprint !== 'string' ||
      !Number.isInteger(data.degree) || !data.units || typeof data.units !== 'object' ||
      !data.localization || !['local_ring', 'none'].includes(String(data.localization.background_mode))) {
    throw new Error('Invalid phenotype response.')
  }
  const ids = new Set<string>()
  for (const cell of data.cells) {
    if (!cell || typeof cell.cell_id !== 'string' || !cell.cell_id ||
        typeof cell.manual_label !== 'string' || ids.has(cell.cell_id) ||
        featureKeys.some((key) => cell[key] !== null &&
          (typeof cell[key] !== 'number' || !Number.isFinite(cell[key])))) {
      throw new Error('Invalid per-cell phenotype measurements.')
    }
    ids.add(cell.cell_id)
  }
  return data
}

export function paddedDomain(values: number[]): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value) }
  if (!Number.isFinite(min)) return [0, 1]
  const padding = max > min ? (max - min) * 0.06 : Math.max(Math.abs(min) * 0.06, 0.01)
  return [min - padding, max + padding]
}

const escapeCsv = (value: string | number | null) => {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function phenotypeCsv(dbName: string, cells: PhenotypeCell[]): string {
  const header = ['dbname', 'cell_id', 'manual_label', ...featureKeys]
  return [header.join(','), ...cells.map((cell) =>
    [dbName, cell.cell_id, cell.manual_label, ...featureKeys.map((key) => cell[key])]
      .map(escapeCsv).join(','),
  )].join('\r\n')
}
