import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Box, Button, Grid, HStack, NativeSelect, Spinner, Stack, Text } from '@chakra-ui/react'
import {
  fetchPhenotypeFeatures, formatPhenotypeValue, metricLabel, paddedDomain, phenotypeMetrics, phenotypePoints,
  type FluoChannel, type MetricKey, type PhenotypeCell,
} from '../utils/phenotypeMap'
import PhenotypePlotAxes from './PhenotypePlotAxes'

const PLOT = { left: 74, right: 424, top: 16, bottom: 220 }
const CURRENT_COLOR = '#dc4141'

function MapSelect({ label, value, onChange, children }: {
  label: string; value: string; onChange: (value: string) => void; children: ReactNode
}) {
  const id = useId()
  return (
    <Box minW="0" fontSize="xs">
      <label htmlFor={id}>{label}</label>
      <NativeSelect.Root size="sm">
        <NativeSelect.Field id={id} value={value} onChange={(event) => onChange(event.target.value)} bg="sand.50">
          {children}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Box>
  )
}

type Props = {
  apiBase: string
  dbName: string
  cellId: string
  viewerLabel: string
  labelOptions: string[]
  revision: number
}

type MeasurementResult = {
  revision: number
  attempt: number
} & ({ cells: PhenotypeCell[]; error?: never } | { cells?: never; error: string })

export default function CellPhenotypeMap({ apiBase, dbName, cellId, viewerLabel, labelOptions, revision }: Props) {
  const [channel, setChannel] = useState<FluoChannel>('fluo1')
  const [labelOverride, setLabelOverride] = useState('')
  const [xMetric, setXMetric] = useState<MetricKey>('top10_fraction')
  const [yMetric, setYMetric] = useState<MetricKey>('normalized_median')
  const [result, setResult] = useState<MeasurementResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const measurements = result?.revision === revision && result.attempt === attempt ? result : null
  const cells = measurements?.cells
  const error = measurements?.error

  useEffect(() => {
    if (!dbName) return
    const controller = new AbortController()
    fetchPhenotypeFeatures(apiBase, dbName, 'local_ring', controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ revision, attempt, cells: data.cells })
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ revision, attempt, error: err instanceof Error ? err.message : 'Could not load phenotype features.' })
        }
      })
    return () => controller.abort()
  }, [apiBase, dbName, revision, attempt])

  const label = labelOverride || viewerLabel
  const labels = useMemo(() => [...new Set([...labelOptions, ...(cells ?? []).map((cell) => cell.manual_label), label])]
    .filter((value) => value !== 'All').sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [cells, labelOptions, label])
  const allPoints = useMemo(() => phenotypePoints(cells ?? [], xMetric, yMetric, channel), [cells, xMetric, yMetric, channel])
  const population = useMemo(() => label === 'All' ? allPoints : allPoints.filter(({ cell }) => cell.manual_label === label), [allPoints, label])
  const populationSize = label === 'All' ? cells?.length : cells?.filter((cell) => cell.manual_label === label).length
  const currentCell = cells?.find((cell) => cell.cell_id === cellId)
  const currentPoint = allPoints.find(({ cell }) => cell.cell_id === cellId)
  const outsidePopulation = currentCell && label !== 'All' && currentCell.manual_label !== label

  // Draw the current cell last so overlapping population points never hide it.
  const displayed = population.filter(({ cell }) => cell.cell_id !== cellId)
  if (currentPoint) displayed.push(currentPoint)
  const xDomain = paddedDomain(displayed.map(({ x }) => x))
  const yDomain = paddedDomain(displayed.map(({ y }) => y))
  const xLabel = metricLabel(xMetric, channel)
  const yLabel = metricLabel(yMetric, channel)
  const axisOptions = phenotypeMetrics.map((metric) =>
    <option key={metric.key} value={metric.key} title={metric.description}>{metric.label}</option>)

  return (
    <Stack gap="2" flex="1" minH="0" overflowY="auto" data-testid="cell-phenotype-map">
      <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="2">
        <MapSelect label="Fluorescence channel" value={channel} onChange={(value) => setChannel(value as FluoChannel)}>
          <option value="fluo1">FLUO1</option><option value="fluo2">FLUO2</option>
        </MapSelect>
        <MapSelect label="Population label" value={labelOverride} onChange={setLabelOverride}>
          <option value="">Viewer filter ({viewerLabel})</option>
          <option value="All">All labels</option>
          {labels.map((value) => <option key={value} value={value}>{value}</option>)}
        </MapSelect>
        <MapSelect label="X axis" value={xMetric} onChange={(value) => setXMetric(value as MetricKey)}>{axisOptions}</MapSelect>
        <MapSelect label="Y axis" value={yMetric} onChange={(value) => setYMetric(value as MetricKey)}>{axisOptions}</MapSelect>
      </Grid>
      {!dbName ? <Text fontSize="sm">Select a database to view its cells.</Text>
        : error ? <HStack gap="2"><Text role="alert" fontSize="sm">{error}</Text>
          <Button size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>Retry</Button></HStack>
        : !cells ? <HStack gap="2" role="status"><Spinner size="sm" /><Text fontSize="sm">Loading phenotype measurements…</Text></HStack>
        : <>
          <HStack gapX="4" gapY="1" flexWrap="wrap" fontSize="xs" aria-live="polite">
            <HStack gap="1.5">
              <Box w="2" h="2" borderRadius="full" bg="var(--app-link)" opacity={0.35} />
              <Text>Population {population.length} / {populationSize} cells</Text>
            </HStack>
            {cellId && <HStack gap="1.5">
              {currentPoint && <Box w="2.5" h="2.5" borderRadius="full" bg={CURRENT_COLOR} />}
              <Text>Current {cellId}{outsidePopulation && ` · label ${currentCell.manual_label} outside population`}
                {!currentPoint && ' · missing axis measurements'}</Text>
            </HStack>}
          </HStack>
          {displayed.length ? (
            <Box bg="sand.50" border="1px solid" borderColor="sand.200" borderRadius="lg" flex="1" minH="12rem" display="grid">
              <svg viewBox="0 0 448 276" role="img" aria-label="Cell phenotype scatter plot"
                style={{ display: 'block', width: '100%', height: '100%' }}>
                <PhenotypePlotAxes plot={PLOT} xDomain={xDomain} yDomain={yDomain} height={276} tickCount={4} xLabel={xLabel} yLabel={yLabel} />
                {displayed.map(({ cell, x, y }) => {
                  const current = cell.cell_id === cellId
                  const cx = PLOT.left + (x - xDomain[0]) / (xDomain[1] - xDomain[0]) * (PLOT.right - PLOT.left)
                  const cy = PLOT.bottom - (y - yDomain[0]) / (yDomain[1] - yDomain[0]) * (PLOT.bottom - PLOT.top)
                  return (
                    <circle key={cell.cell_id} data-cell-id={cell.cell_id} aria-current={current || undefined}
                      cx={cx} cy={cy} r={current ? 6 : 3.5} fill={current ? CURRENT_COLOR : 'var(--app-link)'}
                      fillOpacity={current ? 1 : 0.35} stroke={current ? 'var(--app-bg)' : 'none'} strokeWidth={1.5}>
                      <title>{`${cell.cell_id} · ${xLabel} ${formatPhenotypeValue(x)} · ${yLabel} ${formatPhenotypeValue(y)}`}</title>
                    </circle>
                  )
                })}
              </svg>
            </Box>
          ) : <Text fontSize="sm">{populationSize ? 'No cells have both selected axis measurements.' : 'No cells match this population label.'}</Text>}
        </>}
    </Stack>
  )
}
