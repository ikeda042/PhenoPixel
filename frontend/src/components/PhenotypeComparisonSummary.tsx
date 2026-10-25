import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, HStack, NativeSelect, Stack, Text } from '@chakra-ui/react'
import {
  comparisonSummaryCsv, databaseMetricSummaries, metricLabel, paddedDomain, phenotypeMetrics,
  type BackgroundMode, type ComparisonCell, type FluoChannel, type MetricKey, type PhenotypeDataset,
} from '../utils/phenotypeMap'

const format = (value: number | null) => value === null ? 'Missing' : Number(value.toPrecision(4)).toLocaleString('en-US')

export default function PhenotypeComparisonSummary({ cells, datasets, channel, backgroundMode, label, colors, metric, onMetricChange, featureVersion }: {
  cells: ComparisonCell[]; datasets: PhenotypeDataset[]; channel: FluoChannel;
  backgroundMode: BackgroundMode; label: string; colors: Record<string, string>
  metric: MetricKey; onMetricChange: (metric: MetricKey) => void; featureVersion: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(760)
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(220, Math.min(900, Math.round(entry.contentRect.width)))))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const summaries = useMemo(() => databaseMetricSummaries(cells, datasets.map(({ dbname }) => dbname), metric, channel), [cells, datasets, metric, channel])
  const domain = paddedDomain(summaries.flatMap(({ values }) => values))
  const plot = { left: 52, right: width - 20, top: 18, bottom: 238 }
  const sx = (value: number) => plot.left + (value - domain[0]) / (domain[1] - domain[0]) * (plot.right - plot.left)
  const sy = (value: number) => plot.bottom - value * (plot.bottom - plot.top)
  const tickCount = width < 460 ? 3 : 5
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => index / tickCount)
  const exportCsv = () => {
    const content = comparisonSummaryCsv(summaries, datasets, metric, channel, backgroundMode, label, featureVersion)
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `phenotype-database-comparison-${channel}-${metric}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const cellStyle = { padding: '8px 12px', textAlign: 'left' as const, borderBottom: '1px solid var(--app-border)' }
  return (
    <Stack gap="3" border="1px solid" borderColor="sand.200" borderRadius="lg" p="3" minW="0" data-testid="database-comparison">
      <HStack gap="3" flexWrap="wrap" justify="space-between">
        <Box>
          <Text fontWeight="600">Compare database distributions</Text>
          <Text fontSize="xs" color="ink.700">All cells matching the label · {channel.toUpperCase()} · {backgroundMode === 'local_ring' ? 'Local ring background correction' : 'Raw intensity'}</Text>
        </Box>
        <Box minW="14rem">
          <label htmlFor="comparison-metric" style={{ fontSize: '0.75rem' }}>Distribution metric</label>
          <NativeSelect.Root size="sm"><NativeSelect.Field id="comparison-metric" value={metric} onChange={(event) => onMetricChange(event.target.value as MetricKey)}>
            {phenotypeMetrics.map(({ key }) => <option key={key} value={key}>{metricLabel(key, channel)}</option>)}
          </NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root>
        </Box>
        <Button size="sm" variant="outline" onClick={exportCsv}>Export database summary CSV</Button>
      </HStack>
      <Text fontSize="xs" color="ink.700">Each cumulative curve is normalized within its database: the Y value is the fraction of valid cells at or below the X value. Curves and summary statistics use the full label-filtered population, independently of scatter selection and zoom.</Text>
      <Box ref={container} bg="sand.50" p="2" borderRadius="md" minW="0">
        {summaries.some(({ values }) => values.length) ? (
          <svg viewBox={`0 0 ${width} 300`} style={{ width: '100%', maxHeight: 320, display: 'block' }} role="img" aria-label="Database cumulative distributions">
            {[0, 0.25, 0.5, 0.75, 1].map((value) => <g key={value}>
              <line x1={plot.left} x2={plot.right} y1={sy(value)} y2={sy(value)} stroke="var(--app-border)" />
              <text x={plot.left - 8} y={sy(value) + 4} textAnchor="end" fontSize="12" fill="currentColor">{value}</text>
            </g>)}
            {ticks.map((fraction) => {
              const value = domain[0] + fraction * (domain[1] - domain[0])
              return <text key={fraction} x={sx(value)} y={plot.bottom + 22} textAnchor="middle" fontSize="12" fill="currentColor">{format(value)}</text>
            })}
            {summaries.filter(({ values }) => values.length).map(({ dbname, values }) => {
              const path = [`M${plot.left},${plot.bottom}`]
              for (let index = 0; index < values.length; index++) {
                if (index + 1 < values.length && values[index + 1] === values[index]) continue
                path.push(`H${sx(values[index])}V${sy((index + 1) / values.length)}`)
              }
              path.push(`H${plot.right}`)
              return <path key={dbname} d={path.join('')} stroke={colors[dbname]} strokeWidth="2.5" fill="none" data-dbname={dbname}><title>{dbname}: n = {values.length}</title></path>
            })}
            <path d={`M${plot.left},${plot.top}V${plot.bottom}H${plot.right}`} fill="none" stroke="currentColor" />
            <text x={(plot.left + plot.right) / 2} y="286" fontSize={width < 460 ? 11 : 13} textAnchor="middle" fill="currentColor">{metricLabel(metric, channel)}</text>
            <text transform="translate(14 128) rotate(-90)" textAnchor="middle" fontSize="12" fill="currentColor">Fraction of cells</text>
          </svg>
        ) : <Text p="4" fontSize="sm">No valid measurements for this channel and metric in the selected databases.</Text>}
      </Box>
      <HStack gap="3" flexWrap="wrap">
        {summaries.map(({ dbname, values }) => <HStack key={dbname} gap="1">
          <Box w="2.5" h="2.5" borderRadius="full" bg={colors[dbname]} />
          <Text fontSize="xs" overflowWrap="anywhere">{dbname} (n = {values.length})</Text>
        </HStack>)}
      </HStack>
      <Box overflowX="auto" maxW="full">
        <table style={{ width: '100%', minWidth: 620, fontSize: 12, borderCollapse: 'collapse' }} aria-label="Database distribution summary">
          <thead><tr>{['Database', 'Cells', 'Valid', 'Missing', 'Median', 'Q1–Q3'].map((heading) => <th key={heading} scope="col" style={cellStyle}>{heading}</th>)}</tr></thead>
          <tbody>{summaries.map((summary) => {
            const error = datasets.find(({ dbname }) => dbname === summary.dbname)?.error
            return <tr key={summary.dbname} data-dbname={summary.dbname}>
              <th scope="row" style={cellStyle}>{summary.dbname}</th>
              {error ? <td colSpan={5} style={cellStyle}>Unavailable: {error}</td> : <>
                <td style={cellStyle}>{summary.total}</td><td style={cellStyle}>{summary.values.length}</td><td style={cellStyle}>{summary.missing}</td>
                <td style={cellStyle}>{format(summary.median)}</td><td style={cellStyle}>{format(summary.q1)} – {format(summary.q3)}</td>
              </>}
            </tr>
          })}</tbody>
        </table>
      </Box>
    </Stack>
  )
}
