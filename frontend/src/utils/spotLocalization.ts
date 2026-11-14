export type LocalizedSpot = {
  spot_id: number; raw_x: number; raw_y: number; longitudinal: number; nearest_pole: number
  lateral: number | null; lateral_reason: string | null; amplitude: number; snr: number; bic_improvement: number
}
export type LocalizedCell = {
  cell_id: string; manual_label: string; status: 'ok' | 'skipped'; error: string | null
  length_px: number | null; at_cap: boolean
  settings: { sigma_min: number; sigma_max: number; min_snr: number; min_bic: number; auto_tune: boolean } | null
  spots: LocalizedSpot[]
}
export type SpotLocalization = {
  dbname: string; channel: 'fluo1' | 'fluo2'; label: string; version: string
  max_spots: number; auto_tune: boolean; coordinate_system: string; orientation: string
  summary: { total_cells: number; analyzed_cells: number; skipped_cells: number; positive_cells: number
    total_spots: number; at_cap_cells: number; unmapped_lateral_spots: number }
  cells: LocalizedCell[]
}
export type PositionAxis = 'longitudinal' | 'nearest_pole'
export const axisMaximum = (axis: PositionAxis) => axis === 'nearest_pole' ? 0.5 : 1
export const axisLabel = (axis: PositionAxis) => axis === 'nearest_pole'
  ? 'Distance from nearest pole (% cell length)' : 'Position along centerline (% cell length)'

export function parseSpotLocalization(value: unknown): SpotLocalization {
  const data = value as SpotLocalization | null
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n)
  if (!data || typeof data.dbname !== 'string' || !['fluo1', 'fluo2'].includes(data.channel) ||
      !data.summary || !Object.values(data.summary).every(finite) || !Array.isArray(data.cells) ||
      !data.cells.every((cell) => cell && typeof cell.cell_id === 'string' && typeof cell.manual_label === 'string' &&
        ['ok', 'skipped'].includes(cell.status) && Array.isArray(cell.spots) && cell.spots.every((spot) =>
          spot && [spot.spot_id, spot.raw_x, spot.raw_y, spot.amplitude, spot.snr, spot.bic_improvement,
            spot.longitudinal, spot.nearest_pole].every(finite) &&
          spot.longitudinal >= 0 && spot.longitudinal <= 1 && spot.nearest_pole >= 0 && spot.nearest_pole <= 0.5 &&
          (spot.lateral === null || (finite(spot.lateral) && Math.abs(spot.lateral) <= 1))))) {
    throw new Error('Invalid spot localization response')
  }
  return data
}

export function positionBins(cells: LocalizedCell[], axis: PositionAxis, mode: 'cells' | 'spots', count = 20) {
  const successful = cells.filter((cell) => cell.status === 'ok')
  const bins = Array.from({ length: count }, () => 0)
  for (const cell of successful) {
    const indices = cell.spots.map((spot) => Math.min(count - 1, Math.floor(spot[axis] / axisMaximum(axis) * count)))
    for (const index of mode === 'cells' ? new Set(indices) : indices) bins[index] += 1
  }
  return mode === 'cells' ? bins.map((value) => successful.length ? 100 * value / successful.length : 0) : bins
}

function csv(rows: unknown[][]) {
  return rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
}

export function spotLocalizationCsv(data: SpotLocalization, kind: 'spots' | 'cells') {
  const common = ['dbname', 'channel', 'cell_id', 'manual_label']
  if (kind === 'cells') return csv([
    [...common, 'status', 'error', 'spot_count', 'at_cap', 'length_px', 'sigma_min', 'sigma_max', 'min_snr', 'min_bic'],
    ...data.cells.map((cell) => [data.dbname, data.channel, cell.cell_id, cell.manual_label, cell.status, cell.error,
      cell.status === 'ok' ? cell.spots.length : null, cell.at_cap, cell.length_px,
      cell.settings?.sigma_min, cell.settings?.sigma_max, cell.settings?.min_snr, cell.settings?.min_bic]),
  ])
  const fields = ['spot_id', 'raw_x', 'raw_y', 'longitudinal', 'nearest_pole', 'lateral', 'lateral_reason',
    'amplitude', 'snr', 'bic_improvement'] as const
  return csv([[...common, ...fields], ...data.cells.flatMap((cell) => cell.spots.map((spot) =>
    [data.dbname, data.channel, cell.cell_id, cell.manual_label, ...fields.map((field) => spot[field])]))])
}
