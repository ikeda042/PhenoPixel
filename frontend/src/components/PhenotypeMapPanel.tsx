import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Button, Grid, HStack, NativeSelect, Spinner, Stack, Text } from '@chakra-ui/react'
import PhenotypeComparisonSummary from './PhenotypeComparisonSummary'
import {
  isShapeMetric, metricDescription, metricLabel, metricValue, paddedDomain, parsePhenotypeFeatures,
  parsePhenotypeComparison, phenotypeCellKey, singleDatabaseComparison, phenotypeCsv, phenotypeMetrics,
  type BackgroundMode, type Bounds, type ComparisonCell, type FluoChannel, type MetricKey, type PhenotypeComparison,
} from '../utils/phenotypeMap'

const PALETTE = ['#168477', '#8b5bb5', '#cc6b36', '#327fba', '#bd4d75', '#8c791e', '#5d8390']
const formatNumber = (value: number | null) => value === null ? 'Missing' :
  Number(value.toPrecision(4)).toLocaleString('en-US')
type Selection = { ids: Set<string>; rectangle?: Bounds & { x: MetricKey; y: MetricKey; channel: FluoChannel } }
type ScreenPoint = { x: number; y: number }

function downloadFile(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function CellImage({ apiBase, dbName, cellId, channel }: {
  apiBase: string; dbName: string; cellId: string; channel: 'ph' | FluoChannel
}) {
  const [failed, setFailed] = useState(false)
  const params = new URLSearchParams({ dbname: dbName, cell_id: cellId, image_type: channel, draw_contour: 'true' })
  return (
    <Box bg="sand.50" borderRadius="md" overflow="hidden" aspectRatio={1}>
      {failed ? (
        <Text fontSize="xs" color="ink.700" p="3">No {channel.toUpperCase()} image</Text>
      ) : (
        <img src={`${apiBase}/get-cell-image?${params}`} alt={`${channel.toUpperCase()} ${cellId}`}
          loading="lazy" onError={() => setFailed(true)}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} />
      )}
    </Box>
  )
}

export default function PhenotypeMapPanel({ apiBase, dbName }: { apiBase: string; dbName: string }) {
  const [data, setData] = useState<PhenotypeComparison | null>(null)
  const [availableDatabases, setAvailableDatabases] = useState<string[]>([dbName])
  const [draftDatabases, setDraftDatabases] = useState<string[]>([dbName])
  const [appliedDatabases, setAppliedDatabases] = useState<string[]>([dbName])
  const [databaseSearch, setDatabaseSearch] = useState('')
  const [databaseListError, setDatabaseListError] = useState<string | null>(null)
  const [databaseListReload, setDatabaseListReload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [label, setLabel] = useState('All')
  const [xMetric, setXMetric] = useState<MetricKey>('entropy_norm')
  const [yMetric, setYMetric] = useState<MetricKey>('polar_enrichment')
  const [colorMetric, setColorMetric] = useState<MetricKey | 'manual_label' | 'database'>('axial_offset')
  const [channel, setChannel] = useState<FluoChannel>('fluo1')
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>('local_ring')
  const [distributionMetric, setDistributionMetric] = useState<MetricKey>('entropy_norm')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ start: ScreenPoint; end: ScreenPoint } | null>(null)
  const dragStart = useRef<ScreenPoint | null>(null)
  const [view, setView] = useState<Bounds | null>(null)
  const [galleryPage, setGalleryPage] = useState(0)
  const chartRef = useRef<HTMLDivElement>(null)
  const [chartWidth, setChartWidth] = useState(760)
  const WIDTH = Math.min(chartWidth, 760)
  const HEIGHT = WIDTH < 460 ? 320 : 470
  const PLOT = { left: WIDTH < 460 ? 80 : 86, top: 22, right: WIDTH - 20, bottom: HEIGHT - 65 }

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      setDatabaseListError(null)
      try {
        const response = await fetch(`${apiBase}/get-databases`, { signal: controller.signal })
        if (!response.ok) throw new Error(`Could not list databases (${response.status}).`)
        const result: unknown = await response.json()
        if (!Array.isArray(result) || result.some((name) => typeof name !== 'string')) throw new Error('Invalid database list.')
        if (!controller.signal.aborted) setAvailableDatabases([...new Set([dbName, ...result as string[]])])
      } catch (err) {
        if (!controller.signal.aborted) setDatabaseListError(err instanceof Error ? err.message : 'Could not list databases.')
      }
    }
    void load()
    return () => controller.abort()
  }, [apiBase, dbName, databaseListReload])

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      setLoading(true)
      setError(null)
      setData(null)
      setSelection(null)
      setActiveKey(null)
      setView(null)
      setGalleryPage(0)
      try {
        const multi = appliedDatabases.length > 1
        const params = new URLSearchParams({ dbname: appliedDatabases[0], background_mode: backgroundMode })
        const response = await fetch(multi ? `${apiBase}/get-phenotype-comparison` : `${apiBase}/get-phenotype-features?${params}`, {
          signal: controller.signal,
          method: multi ? 'POST' : 'GET',
          headers: multi ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
          body: multi ? JSON.stringify({ dbnames: appliedDatabases, background_mode: backgroundMode }) : undefined,
        })
        if (!response.ok) throw new Error(`Could not load phenotype features (${response.status}).`)
        const payload: unknown = await response.json()
        const result = multi ? parsePhenotypeComparison(payload) : singleDatabaseComparison(parsePhenotypeFeatures(payload))
        if (!controller.signal.aborted) { setData(result); setLabel('All') }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load phenotype features.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [apiBase, appliedDatabases, backgroundMode, reload])

  useEffect(() => {
    const element = chartRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setChartWidth(Math.max(200, Math.round(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [data])

  const labels = useMemo(() => [...new Set(data?.cells.map((cell) => cell.manual_label) ?? [])]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [data])
  const filtered = useMemo(() => data?.cells.filter((cell) => label === 'All' || cell.manual_label === label) ?? [], [data, label])
  const points = useMemo(() => filtered.flatMap((cell) => {
    const x = metricValue(cell, xMetric, channel)
    const y = metricValue(cell, yMetric, channel)
    return x === null || y === null ? [] : [{ cell, x, y }]
  }), [filtered, xMetric, yMetric, channel])
  const selected = useMemo(() => filtered.filter((cell) => selection?.ids.has(phenotypeCellKey(cell))), [filtered, selection])
  const active = filtered.find((cell) => phenotypeCellKey(cell) === activeKey) ?? selected[0] ?? null
  const isComparing = appliedDatabases.length > 1
  const datasetNames = data?.datasets.map(({ dbname }) => dbname) ?? appliedDatabases
  const databaseColors = Object.fromEntries(datasetNames.map((name, index) => [name, PALETTE[index] ?? `hsl(${index * 137.508 % 360} 55% 45%)`]))
  const xDomain = view ? [view.xMin, view.xMax] : paddedDomain(points.map((point) => point.x))
  const yDomain = view ? [view.yMin, view.yMax] : paddedDomain(points.map((point) => point.y))
  const scaleX = (value: number) => PLOT.left + (value - xDomain[0]) / (xDomain[1] - xDomain[0]) * (PLOT.right - PLOT.left)
  const scaleY = (value: number) => PLOT.bottom - (value - yDomain[0]) / (yDomain[1] - yDomain[0]) * (PLOT.bottom - PLOT.top)
  const unscaleX = (value: number) => xDomain[0] + (value - PLOT.left) / (PLOT.right - PLOT.left) * (xDomain[1] - xDomain[0])
  const unscaleY = (value: number) => yDomain[0] + (PLOT.bottom - value) / (PLOT.bottom - PLOT.top) * (yDomain[1] - yDomain[0])
  const colorValues = colorMetric === 'manual_label' || colorMetric === 'database' ? [] : filtered.flatMap((cell) => {
    const value = metricValue(cell, colorMetric, channel)
    return value === null ? [] : [value]
  })
  let colorMin = Infinity
  let colorMax = -Infinity
  for (const value of colorValues) { colorMin = Math.min(colorMin, value); colorMax = Math.max(colorMax, value) }
  const pointColor = (cell: ComparisonCell) => {
    if (colorMetric === 'database') return databaseColors[cell.dbname]
    if (colorMetric === 'manual_label') return PALETTE[labels.indexOf(cell.manual_label) % PALETTE.length]
    const value = metricValue(cell, colorMetric, channel)
    if (value === null) return '#999999'
    const t = colorMax > colorMin ? (value - colorMin) / (colorMax - colorMin) : 0.5
    return `rgb(${Math.round(22 + 117 * t)}, ${Math.round(132 - 41 * t)}, ${Math.round(119 + 62 * t)})`
  }

  const selectCell = (key: string, additive: boolean) => {
    const ids = new Set(additive ? selection?.ids : [])
    if (additive && ids.has(key)) ids.delete(key)
    else ids.add(key)
    setSelection({ ids })
    setActiveKey(key)
    setGalleryPage(0)
  }
  const cursorPoint = (event: PointerEvent<SVGSVGElement>): ScreenPoint | null => {
    const svg = event.currentTarget
    const matrix = svg.getScreenCTM()
    if (!matrix) return null
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const transformed = point.matrixTransform(matrix.inverse())
    return {
      x: Math.max(PLOT.left, Math.min(PLOT.right, transformed.x)),
      y: Math.max(PLOT.top, Math.min(PLOT.bottom, transformed.y)),
    }
  }
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !points.length) return
    const point = cursorPoint(event)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = point
    setDrag({ start: point, end: point })
  }
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const start = dragStart.current
    const end = cursorPoint(event)
    dragStart.current = null
    setDrag(null)
    if (!start || !end) return
    if (Math.hypot(end.x - start.x, end.y - start.y) < 4) { setSelection(null); return }
    const bounds = {
      xMin: unscaleX(Math.min(start.x, end.x)), xMax: unscaleX(Math.max(start.x, end.x)),
      yMin: unscaleY(Math.max(start.y, end.y)), yMax: unscaleY(Math.min(start.y, end.y)),
    }
    const ids = new Set(points.filter(({ x, y }) => x >= bounds.xMin && x <= bounds.xMax &&
      y >= bounds.yMin && y <= bounds.yMax).map(({ cell }) => phenotypeCellKey(cell)))
    setSelection({ ids, rectangle: { ...bounds, x: xMetric, y: yMetric, channel } })
    setActiveKey(null)
    setGalleryPage(0)
  }
  const zoomToSelection = () => {
    const chosen = points.filter(({ cell }) => selection?.ids.has(phenotypeCellKey(cell)))
    const [xMin, xMax] = paddedDomain(chosen.map(({ x }) => x))
    const [yMin, yMax] = paddedDomain(chosen.map(({ y }) => y))
    if (chosen.length) setView({ xMin, xMax, yMin, yMax })
  }
  const safeName = isComparing ? 'database-comparison' : appliedDatabases[0].replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'database'
  const exportSelection = () => {
    if (!data || !selected.length) return
    downloadFile(JSON.stringify({
      dbname: isComparing ? undefined : data.datasets[0].dbname,
      datasets: data.datasets, comparison_version: data.comparison_version,
      feature_version: data.feature_version, source_fingerprint: data.source_fingerprint,
      degree: data.degree, units: data.units, localization: data.localization, exported_at: new Date().toISOString(),
      settings: { label, x_metric: xMetric, y_metric: yMetric, color_metric: colorMetric, channel, background_mode: backgroundMode, view,
        distribution_metric: distributionMetric,
        selection_rectangle: selection?.rectangle ?? null },
      cells: selected,
    }, null, 2), `phenotype-${safeName}-selection.json`, 'application/json')
  }
  const tickCount = WIDTH < 460 ? 3 : 5
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => index)
  const rectangle = selection?.rectangle
  const showRectangle = rectangle && rectangle.x === xMetric && rectangle.y === yMetric && rectangle.channel === channel
  const visiblePoints = points.filter(({ x, y }) => x >= xDomain[0] && x <= xDomain[1] && y >= yDomain[0] && y <= yDomain[1])
  const galleryCount = Math.ceil(selected.length / 24)
  const currentPage = Math.min(galleryPage, Math.max(0, galleryCount - 1))
  const databaseOptions = [...new Set([...availableDatabases, ...draftDatabases, ...appliedDatabases])]
    .filter((name) => name.toLowerCase().includes(databaseSearch.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const databasesChanged = JSON.stringify([...draftDatabases].sort()) !== JSON.stringify([...appliedDatabases].sort())
  const cellActionLabel = (action: string, cell: ComparisonCell) => `${action} cell ${cell.cell_id}${isComparing ? ` in ${cell.dbname}` : ''}`
  const axisOptions = [
    <optgroup key="fluorescence" label="Fluorescence localization">
      {phenotypeMetrics.filter(({ key }) => !isShapeMetric(key)).map(({ key, description }) =>
        <option key={key} value={key} title={description}>{metricLabel(key, channel)}</option>)}
    </optgroup>,
    <optgroup key="shape" label="Cell shape (reference)">
      {phenotypeMetrics.filter(({ key }) => isShapeMetric(key)).map(({ key, description }) =>
        <option key={key} value={key} title={description}>{metricLabel(key, channel)}</option>)}
    </optgroup>,
  ]

  return (
    <Stack gap="4" mt="3" data-testid="phenotype-map">
      <HStack justify="space-between" flexWrap="wrap" gap="3">
        <Box>
          <Text fontWeight="600" color="ink.900">Fluorescence localization map</Text>
          <Text fontSize="sm" color="ink.700">Compare signal concentration, polar/midcell enrichment and axial distribution for each cell.</Text>
        </Box>
        <Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)} disabled={loading}>
          {loading ? 'Calculating...' : 'Refresh measurements'}
        </Button>
      </HStack>
      <Box border="1px solid" borderColor="sand.200" borderRadius="lg" p="3">
        <HStack justify="space-between" gap="3" flexWrap="wrap" mb="2">
          <Box><Text fontWeight="600" fontSize="sm">Compare databases</Text>
            <Text fontSize="xs" color="ink.700">Select sources, then apply. Every database uses the same fluorescence channel, background correction and metric definitions.</Text></Box>
          <HStack gap="2" flexWrap="wrap">
            <Button size="xs" variant="outline" onClick={() => setDatabaseListReload((value) => value + 1)}>Reload DB list</Button>
            <Button size="sm" variant="outline" disabled={!draftDatabases.length || !databasesChanged || loading} onClick={() => {
              setAppliedDatabases([...draftDatabases]); setColorMetric(draftDatabases.length > 1 ? 'database' : 'axial_offset')
            }}>Apply databases ({draftDatabases.length})</Button>
          </HStack>
        </HStack>
        <Box asChild border="1px solid" borderColor="sand.200" borderRadius="md" bg="sand.50" p="2" w="full" mb="2">
          <input aria-label="Search comparison databases" placeholder="Search databases" value={databaseSearch} onChange={(event) => setDatabaseSearch(event.target.value)} />
        </Box>
        <Box maxH="32" overflowY="auto">
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }} gap="2">
            {databaseOptions.map((name) => <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, overflowWrap: 'anywhere' }}>
              <input type="checkbox" aria-label={`Compare database ${name}`} checked={draftDatabases.includes(name)} onChange={(event) => {
                const checked = event.target.checked
                setDraftDatabases((names) => checked ? [...names, name] : names.filter((value) => value !== name))
              }} />
              {name}
            </label>)}
          </Grid>
        </Box>
        {databaseListError && <Text fontSize="xs" color="violet.300" mt="2">{databaseListError} Reload DB list to retry.</Text>}
        <Text fontSize="xs" color="ink.700" mt="2">Loaded sources: {appliedDatabases.join(', ')}</Text>
      </Box>
      {loading && <HStack gap="2"><Spinner size="sm" /><Text fontSize="sm">Calculating per-cell features...</Text></HStack>}
      {error && <Text role="alert" color="violet.300">{error} Use Refresh measurements to retry.</Text>}
      {data && (
        <>
          {data.datasets.filter(({ error }) => error).map((dataset) => <Text key={dataset.dbname} role="alert" fontSize="sm" color="violet.300">
            {dataset.dbname}: {dataset.error}. This database is excluded from plotted measurements.
          </Text>)}
          <Grid templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))', xl: 'repeat(6, minmax(0, 1fr))' }} gap="3">
            <Box><label htmlFor="phenotype-label" style={{ fontSize: '0.75rem' }}>Manual label</label>
              <NativeSelect.Root size="sm"><NativeSelect.Field id="phenotype-label" value={label}
                onChange={(event) => { setLabel(event.target.value); setSelection(null); setActiveKey(null); setView(null); setGalleryPage(0) }}>
                <option value="All">All labels</option>{labels.map((value) => <option key={value} value={value}>{value}</option>)}
              </NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
            <Box><label htmlFor="phenotype-x" style={{ fontSize: '0.75rem' }}>X axis</label>
              <NativeSelect.Root size="sm"><NativeSelect.Field id="phenotype-x" value={xMetric}
                onChange={(event) => { setXMetric(event.target.value as MetricKey); setView(null) }}>{axisOptions}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
            <Box><label htmlFor="phenotype-y" style={{ fontSize: '0.75rem' }}>Y axis</label>
              <NativeSelect.Root size="sm"><NativeSelect.Field id="phenotype-y" value={yMetric}
                onChange={(event) => { setYMetric(event.target.value as MetricKey); setView(null) }}>{axisOptions}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
            <Box><label htmlFor="phenotype-color" style={{ fontSize: '0.75rem' }}>Color by</label>
              <NativeSelect.Root size="sm"><NativeSelect.Field id="phenotype-color" value={colorMetric}
                onChange={(event) => setColorMetric(event.target.value as MetricKey | 'manual_label' | 'database')}>
                <option value="database">Database</option><option value="manual_label">Manual label</option>{axisOptions}
              </NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
            <Box><label htmlFor="phenotype-channel" style={{ fontSize: '0.75rem' }}>Fluorescence channel</label>
              <NativeSelect.Root size="sm"><NativeSelect.Field id="phenotype-channel" value={channel}
                onChange={(event) => { setChannel(event.target.value as FluoChannel); setView(null) }}>
                <option value="fluo1">FLUO1</option><option value="fluo2">FLUO2</option>
              </NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
            <Box><label htmlFor="phenotype-background" style={{ fontSize: '0.75rem' }}>Background correction</label>
              <NativeSelect.Root size="sm"><NativeSelect.Field id="phenotype-background" value={backgroundMode}
                onChange={(event) => setBackgroundMode(event.target.value as BackgroundMode)}>
                <option value="local_ring">Local ring median (3 px)</option><option value="none">None (raw intensity)</option>
              </NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
          </Grid>
          <HStack gap="2" flexWrap="wrap" aria-label="Localization plot presets">
            <Text fontSize="xs" color="ink.700">Plot presets</Text>
            <Button size="xs" variant="outline" onClick={() => { setXMetric('entropy_norm'); setYMetric('polar_enrichment'); setView(null) }}>Concentration × poles</Button>
            <Button size="xs" variant="outline" onClick={() => { setXMetric('polar_enrichment'); setYMetric('midcell_enrichment'); setView(null) }}>Poles × midcell</Button>
            <Button size="xs" variant="outline" onClick={() => { setXMetric('axial_spread'); setYMetric('axial_offset'); setView(null) }}>Spread × offset</Button>
          </HStack>
          <HStack justify="space-between" flexWrap="wrap" gap="2">
            <Text fontSize="sm" aria-live="polite" data-testid="phenotype-counts">
              Plotted {points.length} / {filtered.length} cells · Missing axis measurements: {filtered.length - points.length} · Selected: {selected.length}
            </Text>
            <HStack gap="2" flexWrap="wrap">
              <Button size="xs" variant="outline" disabled={!visiblePoints.length} onClick={() => {
                setSelection({ ids: new Set(visiblePoints.map(({ cell }) => phenotypeCellKey(cell))) }); setGalleryPage(0)
              }}>Select all visible</Button>
              <Button size="xs" variant="outline" disabled={!selected.length} onClick={() => { setSelection(null); setActiveKey(null) }}>Clear selection</Button>
              <Button size="xs" variant="outline" disabled={!selected.some((cell) => metricValue(cell, xMetric, channel) !== null && metricValue(cell, yMetric, channel) !== null)} onClick={zoomToSelection}>Zoom to selection</Button>
              <Button size="xs" variant="outline" disabled={!view} onClick={() => setView(null)}>Reset view</Button>
            </HStack>
          </HStack>
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', xl: 'minmax(0, 3fr) minmax(240px, 1fr)' }} gap="4" alignItems="start">
            <Box ref={chartRef} minW="0" bg="sand.50" border="1px solid" borderColor="sand.200" borderRadius="lg" p="3">
              <Text fontSize="xs" color="ink.700" mb="2">Click a point to select a cell. Drag an empty area to select a rectangle. Shift-click adds or removes a cell.</Text>
              {points.length ? (
                <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: '100%', maxHeight: 'min(50vh, 470px)', display: 'block', touchAction: 'none', userSelect: 'none' }}
                  role="group" aria-label="Phenotype scatter plot" data-testid="phenotype-scatter"
                  onPointerDown={onPointerDown} onPointerMove={(event) => {
                    const end = cursorPoint(event)
                    if (dragStart.current && end) setDrag({ start: dragStart.current, end })
                  }} onPointerUp={onPointerUp} onPointerCancel={() => { dragStart.current = null; setDrag(null) }}>
                  <rect x={PLOT.left} y={PLOT.top} width={PLOT.right - PLOT.left} height={PLOT.bottom - PLOT.top} fill="transparent" />
                  {ticks.map((index) => {
                    const x = xDomain[0] + (xDomain[1] - xDomain[0]) * index / tickCount
                    const y = yDomain[0] + (yDomain[1] - yDomain[0]) * index / tickCount
                    return <g key={index} pointerEvents="none">
                      <line x1={scaleX(x)} x2={scaleX(x)} y1={PLOT.top} y2={PLOT.bottom} stroke="var(--chakra-colors-sand-200)" />
                      <line x1={PLOT.left} x2={PLOT.right} y1={scaleY(y)} y2={scaleY(y)} stroke="var(--chakra-colors-sand-200)" />
                      <text x={scaleX(x)} y={PLOT.bottom + 24} textAnchor="middle" fontSize="12" fill="currentColor">{formatNumber(x)}</text>
                      <text x={PLOT.left - 10} y={scaleY(y) + 4} textAnchor="end" fontSize="12" fill="currentColor">{formatNumber(y)}</text>
                    </g>
                  })}
                  <path d={`M${PLOT.left},${PLOT.top}V${PLOT.bottom}H${PLOT.right}`} fill="none" stroke="currentColor" pointerEvents="none" />
                  {visiblePoints.map(({ cell, x, y }) => (
                    <circle key={phenotypeCellKey(cell)} cx={scaleX(x)} cy={scaleY(y)} r={selection?.ids.has(phenotypeCellKey(cell)) ? 6 : 4.5}
                      fill={pointColor(cell)} fillOpacity={selection?.ids.size && !selection.ids.has(phenotypeCellKey(cell)) ? 0.25 : 0.85}
                      stroke={selection?.ids.has(phenotypeCellKey(cell)) ? 'var(--chakra-colors-ink-900)' : 'transparent'} strokeWidth="2"
                      role="button" tabIndex={0} aria-label={cellActionLabel('Select', cell)} aria-pressed={selection?.ids.has(phenotypeCellKey(cell)) ?? false}
                      data-cell-id={cell.cell_id} data-dbname={cell.dbname} style={{ cursor: 'pointer' }}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => selectCell(phenotypeCellKey(cell), event.shiftKey || event.ctrlKey || event.metaKey)}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault(); selectCell(phenotypeCellKey(cell), event.shiftKey || event.ctrlKey || event.metaKey)
                      } }}>
                      <title>{`${cell.dbname} / ${cell.cell_id}\n${metricLabel(xMetric, channel)}: ${formatNumber(x)}\n${metricLabel(yMetric, channel)}: ${formatNumber(y)}`}</title>
                    </circle>
                  ))}
                  {showRectangle && <rect x={scaleX(rectangle.xMin)} y={scaleY(rectangle.yMax)}
                    width={scaleX(rectangle.xMax) - scaleX(rectangle.xMin)} height={scaleY(rectangle.yMin) - scaleY(rectangle.yMax)}
                    fill="none" stroke="#168477" strokeDasharray="5 4" pointerEvents="none" />}
                  {drag && <rect x={Math.min(drag.start.x, drag.end.x)} y={Math.min(drag.start.y, drag.end.y)}
                    width={Math.abs(drag.start.x - drag.end.x)} height={Math.abs(drag.start.y - drag.end.y)}
                    fill="#168477" fillOpacity="0.12" stroke="#168477" pointerEvents="none" />}
                  <text x={(PLOT.left + PLOT.right) / 2} y={HEIGHT - 12} textAnchor="middle" fill="currentColor" fontSize="14" pointerEvents="none">{metricLabel(xMetric, channel)}</text>
                  <text transform={`translate(20 ${(PLOT.top + PLOT.bottom) / 2}) rotate(-90)`} textAnchor="middle" fill="currentColor" fontSize="14" pointerEvents="none">{metricLabel(yMetric, channel)}</text>
                </svg>
              ) : <Text p="8" fontSize="sm">{filtered.length ? 'No cells have both selected axis measurements. Choose another metric or channel.' : 'No cells match this label.'}</Text>}
              <HStack gap="3" flexWrap="wrap" mt="2" aria-label="Color legend">
                {colorMetric === 'database' ? datasetNames.map((name) => <HStack key={name} gap="1"><Box w="2.5" h="2.5" borderRadius="full" bg={databaseColors[name]} /><Text fontSize="xs" overflowWrap="anywhere">{name}</Text></HStack>) : colorMetric === 'manual_label' ? labels.map((value, index) => (
                  <HStack key={value} gap="1"><Box w="2.5" h="2.5" borderRadius="full" bg={PALETTE[index % PALETTE.length]} /><Text fontSize="xs">Label {value}</Text></HStack>
                )) : <><Text fontSize="xs">{metricLabel(colorMetric, channel)}</Text>
                  <Box w="24" h="2" borderRadius="full" background="linear-gradient(to right, #168477, #8b5bb5)" />
                  <Text fontSize="xs">{Number.isFinite(colorMin) ? `${formatNumber(colorMin)} – ${formatNumber(colorMax)}` : 'No values'} · Gray: missing</Text></>}
              </HStack>
              <Text fontSize="xs" color="ink.700" mt="3">X: {metricDescription(xMetric)}</Text>
              <Text fontSize="xs" color="ink.700" mt="1">Y: {metricDescription(yMetric)}</Text>
            </Box>
            <Box border="1px solid" borderColor="sand.200" borderRadius="lg" p="3" minW="0">
              <Text fontWeight="600" fontSize="sm">Cell details</Text>
              {active ? <Stack gap="3" mt="2">
                <Text fontSize="sm" fontWeight="600">{active.cell_id} · Label {active.manual_label}</Text>
                <Text fontSize="xs" color="ink.700" overflowWrap="anywhere">Database: {active.dbname}</Text>
                <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="2">
                  {(['ph', channel] as const).map((imageChannel) => <Box key={`${phenotypeCellKey(active)}:${imageChannel}`}>
                    <Text fontSize="xs" mb="1">{imageChannel.toUpperCase()}</Text>
                    <CellImage apiBase={apiBase} dbName={active.dbname} cellId={active.cell_id} channel={imageChannel} />
                  </Box>)}
                </Grid>
                {phenotypeMetrics.map(({ key }) => <HStack key={key} justify="space-between" gap="2">
                  <Text fontSize="xs">{metricLabel(key, channel)}</Text><Text fontSize="xs" fontWeight="600">{formatNumber(metricValue(active, key, channel))}</Text>
                </HStack>)}
                <Text fontSize="xs" color="ink.700">Estimated background: {formatNumber(active[`${channel}_background_intensity`])} image intensity units</Text>
                <RouterLink to={`/cells?${new URLSearchParams({ db: active.dbname, cell_id: active.cell_id })}`}>
                  <Text fontSize="sm" color="tide.600" textDecoration="underline">Open Cell Viewer</Text>
                </RouterLink>
              </Stack> : <Text mt="2" fontSize="sm" color="ink.700">Select a point or a cell in the gallery to inspect its images and measurements.</Text>}
            </Box>
          </Grid>
          {isComparing && <PhenotypeComparisonSummary cells={filtered} datasets={data.datasets} channel={channel}
            backgroundMode={backgroundMode} label={label} colors={databaseColors} metric={distributionMetric}
            onMetricChange={setDistributionMetric} featureVersion={data.feature_version} />}
          <HStack justify="space-between" flexWrap="wrap" gap="2">
            <Text fontWeight="600" fontSize="sm">Selected cells ({selected.length})</Text>
            <HStack gap="2" flexWrap="wrap">
              <Button size="sm" variant="outline" disabled={!selected.length} onClick={() => downloadFile(
                phenotypeCsv(selected), `phenotype-${safeName}-selected.csv`, 'text/csv;charset=utf-8',
              )}>Export selected CSV</Button>
              <Button size="sm" variant="outline" disabled={!selected.length} onClick={exportSelection}>Export selection JSON</Button>
            </HStack>
          </HStack>
          {!selected.length && <Text fontSize="sm" color="ink.700">Selected cells will appear here with their original PH images. Missing measurements stay empty in CSV exports.</Text>}
          <Grid templateColumns={{ base: 'repeat(3, minmax(0, 1fr))', md: 'repeat(6, minmax(0, 1fr))', xl: 'repeat(8, minmax(0, 1fr))' }} gap="3" data-testid="phenotype-gallery">
            {selected.slice(currentPage * 24, (currentPage + 1) * 24).map((cell) => (
              <Box asChild key={phenotypeCellKey(cell)}
                textAlign="left" border="2px solid" borderColor={active && phenotypeCellKey(active) === phenotypeCellKey(cell) ? 'tide.600' : 'sand.200'}
                borderRadius="md" p="1">
                <button type="button" aria-label={cellActionLabel('Inspect', cell)} onClick={() => setActiveKey(phenotypeCellKey(cell))}>
                <CellImage apiBase={apiBase} dbName={cell.dbname} cellId={cell.cell_id} channel="ph" />
                <Text fontSize="xs" mt="1" overflowWrap="anywhere">{cell.cell_id}</Text>
                <Text fontSize="xs" color="ink.700">Label {cell.manual_label}</Text>
                {isComparing && <Text fontSize="xs" color="ink.700" overflowWrap="anywhere">{cell.dbname}</Text>}
                </button>
              </Box>
            ))}
          </Grid>
          {galleryCount > 1 && <HStack gap="3" justify="center">
            <Button size="xs" variant="outline" disabled={!currentPage} onClick={() => setGalleryPage(currentPage - 1)}>Previous cells</Button>
            <Text fontSize="xs">Page {currentPage + 1} / {galleryCount}</Text>
            <Button size="xs" variant="outline" disabled={currentPage + 1 >= galleryCount} onClick={() => setGalleryPage(currentPage + 1)}>Next cells</Button>
          </HStack>}
          <Text fontSize="xs" color="ink.700">Localization metrics use nonnegative signal after the selected background correction. No remaining signal or no available background ring gives missing localization values. Pole regions are the terminal 20% at each end; midcell is 40–60% of centerline arc length. Axial orientation is unsigned. Selection JSON records these definitions and correction settings.</Text>
        </>
      )}
    </Stack>
  )
}
