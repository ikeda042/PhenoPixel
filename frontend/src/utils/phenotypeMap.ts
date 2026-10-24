export const phenotypeMetrics = [
  { key: 'length_px', label: 'Cell length', unit: 'px' },
  { key: 'width_mean_px', label: 'Mean full width', unit: 'px' },
  { key: 'width_median_px', label: 'Median full width', unit: 'px' },
  { key: 'area_px2', label: 'Cell area', unit: 'px²' },
  { key: 'normalized_median', label: 'Normalized median', unit: '' },
] as const

export type MetricKey = typeof phenotypeMetrics[number]['key']
export type FluoChannel = 'fluo1' | 'fluo2'
export type PhenotypeCell = {
  cell_id: string
  manual_label: string
  length_px: number | null
  width_mean_px: number | null
  width_median_px: number | null
  area_px2: number | null
  fluo1_normalized_median: number | null
  fluo2_normalized_median: number | null
}
export type PhenotypeFeatures = {
  dbname: string
  feature_version: string
  source_fingerprint: string
  degree: number
  units: Record<string, string>
  cells: PhenotypeCell[]
}
export type Bounds = { xMin: number; xMax: number; yMin: number; yMax: number }

export const metricValue = (cell: PhenotypeCell, key: MetricKey, channel: FluoChannel) => {
  const value = key === 'normalized_median' ? cell[`${channel}_normalized_median`] : cell[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const metricLabel = (key: MetricKey, channel: FluoChannel) => {
  const metric = phenotypeMetrics.find((item) => item.key === key)!
  return `${key === 'normalized_median' ? `${channel.toUpperCase()} ` : ''}${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`
}

export const featureKeys = [
  'length_px', 'width_mean_px', 'width_median_px', 'area_px2',
  'fluo1_normalized_median', 'fluo2_normalized_median',
] as const

export function parsePhenotypeFeatures(payload: unknown): PhenotypeFeatures {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid phenotype response.')
  const data = payload as PhenotypeFeatures
  if (!Array.isArray(data.cells) || typeof data.dbname !== 'string' ||
      typeof data.feature_version !== 'string' || typeof data.source_fingerprint !== 'string' ||
      !Number.isInteger(data.degree) || !data.units || typeof data.units !== 'object') {
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
  const padding = max > min ? (max - min) * 0.06 : Math.max(Math.abs(min) * 0.06, 1)
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
