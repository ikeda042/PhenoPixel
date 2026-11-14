import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Box, Button, HStack, NativeSelect, Stack, Text } from '@chakra-ui/react'
import { axisLabel, axisMaximum, parseSpotLocalization, positionBins, spotLocalizationCsv,
  type PositionAxis, type SpotLocalization } from '../utils/spotLocalization'

const LEFT = 75, RIGHT = 950, TOP = 55, BOTTOM = 290
const ticks = [0, 0.25, 0.5, 0.75, 1]
const PAGE_SIZE = 25
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (value: string) => void; options: [string, string][]
}) {
  return <Box><Text fontSize="xs" color="ink.700" mb="1">{label}</Text>
    <NativeSelect.Root size="sm"><NativeSelect.Field aria-label={label} value={value}
      onChange={(event) => onChange(event.target.value)} bg="sand.50">
      {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root>
  </Box>
}
function Axes({ axis, signed = false, yLabel }: { axis: PositionAxis; signed?: boolean; yLabel: string }) {
  return <g fill="#53656b" fontSize="14" fontFamily="sans-serif">
    {ticks.map((tick) => <g key={tick}>
      <line x1={LEFT + tick * (RIGHT - LEFT)} x2={LEFT + tick * (RIGHT - LEFT)} y1={TOP} y2={BOTTOM} stroke="#dce4e5" />
      <text x={LEFT + tick * (RIGHT - LEFT)} y={BOTTOM + 23} textAnchor="middle">{tick * axisMaximum(axis) * 100}%</text>
      <line x1={LEFT} x2={RIGHT} y1={BOTTOM - tick * (BOTTOM - TOP)} y2={BOTTOM - tick * (BOTTOM - TOP)} stroke="#dce4e5" />
      <text x={LEFT - 12} y={BOTTOM - tick * (BOTTOM - TOP) + 5} textAnchor="end">{signed ? tick * 2 - 1 : tick}</text>
    </g>)}
    <text x={(LEFT + RIGHT) / 2} y={BOTTOM + 49} textAnchor="middle">{axisLabel(axis)}</text>
    <text transform={`translate(20 ${(TOP + BOTTOM) / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
  </g>
}

export default function SpotLocalizationPanel({ apiBase, dbName }: { apiBase: string; dbName: string }) {
  const [label, setLabel] = useState('All')
  const [labels, setLabels] = useState<string[]>(['All', '1', '2', '3', 'N/A'])
  const [labelError, setLabelError] = useState<string | null>(null)
  const [channel, setChannel] = useState('fluo1')
  const [data, setData] = useState<SpotLocalization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [axis, setAxis] = useState<PositionAxis>('nearest_pole')
  const [frequency, setFrequency] = useState<'cells' | 'spots'>('cells')
  const [page, setPage] = useState(0)
  const [activeCell, setActiveCell] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const plotRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    const request = new AbortController()
    void fetch(`${apiBase}/get-manual-labels?${new URLSearchParams({ dbname: dbName })}`, { signal: request.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load manual labels. Default labels are available.')
        const result: unknown = await response.json()
        if (!Array.isArray(result)) throw new Error('Could not load manual labels. Default labels are available.')
        if (!request.signal.aborted) setLabels(['All', ...new Set(result.map(String).filter((value) => value !== 'All')), 'N/A']
          .filter((value, index, values) => values.indexOf(value) === index))
      }).catch((err: Error) => { if (!request.signal.aborted) setLabelError(err.message) })
    return () => { request.abort(); controller.current?.abort() }
  }, [apiBase, dbName])

  const reset = () => {
    controller.current?.abort()
    setLoading(false); setData(null); setError(null); setActiveCell(null); setPage(0)
  }
  const calculate = async () => {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setData(null); setError(null); setLoading(true); setPage(0); setActiveCell(null)
    try {
      const response = await fetch(`${apiBase}/get-gfp-spot-localization?${new URLSearchParams({ dbname: dbName, label, channel })}`,
        { signal: request.signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(typeof payload?.detail === 'string' ? payload.detail : `Calculation failed (${response.status})`)
      }
      const result = parseSpotLocalization(await response.json())
      if (!request.signal.aborted) setData(result)
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof Error ? err.message : 'Calculation failed')
    } finally { if (!request.signal.aborted) setLoading(false) }
  }
  const points = useMemo(() => data?.cells.flatMap((cell) => cell.spots.map((spot) => ({ cell, spot }))) ?? [], [data])
  const bins = useMemo(() => positionBins(data?.cells ?? [], axis, frequency), [data, axis, frequency])
  const maxBin = frequency === 'cells' ? 100 : Math.max(1, ...bins)
  const signed = axis === 'longitudinal'
  const xPosition = (value: number) => LEFT + value / axisMaximum(axis) * (RIGHT - LEFT)
  const rows = data?.cells.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? []
  const selected = data?.cells.find((cell) => cell.cell_id === activeCell)
  const filename = `${dbName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${channel}-spot-localization`
  const exportPlot = () => {
    if (!plotRef.current) return
    const svg = plotRef.current.cloneNode(true) as SVGSVGElement
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    svg.setAttribute('width', '1000'); svg.setAttribute('height', '365')
    download(new XMLSerializer().serializeToString(svg), `${filename}.svg`, 'image/svg+xml')
  }

  return <Stack gap="4" mt="3" data-testid="spot-localization">
    <Text fontSize="lg" fontWeight="600">GFP spot localization</Text>
    <Text fontSize="sm" color="ink.700">
      Compare detected foci in cell-relative coordinates. The contour determines the centerline and local width;
      GFP intensity does not determine orientation.
    </Text>
    <HStack gap="4" flexWrap="wrap" align="end">
      <Select label="Spot manual label" value={label} onChange={(value) => { reset(); setLabel(value) }}
        options={labels.map((value) => [value, value])} />
      <Select label="GFP channel" value={channel} onChange={(value) => { reset(); setChannel(value) }}
        options={['fluo1', 'fluo2'].map((value) => [value, value.toUpperCase()])} />
      <Text fontSize="sm">Auto · Max spots: 10 / cell</Text>
      <Button size="sm" variant="outline" onClick={() => void calculate()} loading={loading}
        loadingText="Calculating…" disabled={!dbName || loading}>Calc</Button>
    </HStack>
    {labelError && <Text fontSize="sm" role="alert">{labelError}</Text>}
    {loading && <Text role="status" fontSize="sm">Detecting spots and normalizing cell coordinates… Large populations may take a few minutes.</Text>}
    {error && <Text role="alert" color="violet.300">{error}</Text>}
    {!data && !loading && !error && <Text fontSize="sm">Choose a label and GFP channel, then press Calc.</Text>}
    {data && <>
      <HStack flexWrap="wrap" gap="4" aria-label="Localization summary">
        {[
          ['Analyzed cells', data.summary.analyzed_cells], ['Spot-positive cells', data.summary.positive_cells],
          ['Spots', data.summary.total_spots], ['Cells at cap', data.summary.at_cap_cells], ['Skipped cells', data.summary.skipped_cells],
        ].map(([title, value]) => <Box key={title} bg="sand.100" px="4" py="2" borderRadius="md">
          <Text fontSize="xs" color="ink.700">{title}</Text><Text fontWeight="600">{value}</Text>
        </Box>)}
      </HStack>
      {data.summary.total_cells === 0 ? <Text>No cells match this label.</Text> : <>
        {data.summary.analyzed_cells === 0 && <Text role="status">No cells could be analyzed. See the cell rows for reasons.</Text>}
        {data.summary.analyzed_cells > 0 && data.summary.total_spots === 0 && <Text role="status">No spots met the acceptance criteria. Zero-spot cells are included in cell frequencies.</Text>}
        <HStack flexWrap="wrap" gap="4" align="end">
          <Select label="Position axis" value={axis} onChange={(value) => setAxis(value as PositionAxis)}
            options={[['nearest_pole', 'Nearest pole (orientation independent)'], ['longitudinal', 'Full length (unassigned poles)']]} />
          <Select label="Distribution measure" value={frequency} onChange={(value) => setFrequency(value as 'cells' | 'spots')}
            options={[[ 'cells', 'Cells with a spot (%)'], ['spots', 'Spot count']]} />
          <Button size="sm" variant="outline" onClick={() => download(spotLocalizationCsv(data, 'spots'), `${filename}-spots.csv`, 'text/csv')}>Export spots CSV</Button>
          <Button size="sm" variant="outline" onClick={() => download(spotLocalizationCsv(data, 'cells'), `${filename}-cells.csv`, 'text/csv')}>Export cells CSV</Button>
          <Button size="sm" variant="outline" onClick={exportPlot}>Export map SVG</Button>
        </HStack>
        <Text fontSize="xs" color="ink.700">
          {signed ? '0% and 100% are unassigned poles, 50% is midcell. Signs and left/right are not biological polarity.'
            : '0% is a pole, 50% is midcell. Transverse position is folded: 0 = centerline, 1 = local boundary.'}
          {' '}No mirrored copies are added. Cell frequencies count each cell once per bin, including zero-spot cells in the denominator.
          {' '}These are position frequencies, not enrichment relative to uniform spatial density.
        </Text>
        <Box bg="sand.50" borderWidth="1px" borderColor="sand.200" borderRadius="lg" overflowX="auto">
          <svg ref={plotRef} viewBox="0 0 1000 365" style={{ width: '100%', minWidth: 550, display: 'block' }} role="img" aria-label="Normalized GFP spot map">
            <rect width="1000" height="365" fill="#f8fbfa" />
            <text x="75" y="27" fontSize="18" fontFamily="sans-serif" fill="#243e42">GFP spot map · {data.channel.toUpperCase()} · label {data.label} · {data.summary.analyzed_cells} cells</text>
            <Axes axis={axis} signed={signed} yLabel={signed ? 'Signed transverse position' : 'Absolute transverse position'} />
            {points.filter(({ spot }) => spot.lateral !== null).map(({ cell, spot }) => {
              const y = signed ? (spot.lateral! + 1) / 2 : Math.abs(spot.lateral!)
              return <circle key={`${cell.cell_id}-${spot.spot_id}`} cx={xPosition(spot[axis])} cy={BOTTOM - y * (BOTTOM - TOP)}
                r={cell.cell_id === activeCell ? 5 : 3.5} fill={cell.cell_id === activeCell ? '#a650b5' : '#168477'}
                opacity={cell.cell_id === activeCell ? 1 : 0.4} style={{ cursor: 'pointer' }}
                onClick={() => setActiveCell(cell.cell_id)}>
                <title>{cell.cell_id} · spot {spot.spot_id} · position {(spot.longitudinal * 100).toFixed(1)}% · SNR {spot.snr.toFixed(1)}</title>
              </circle>
            })}
          </svg>
        </Box>
        {data.summary.unmapped_lateral_spots > 0 && <Text fontSize="xs" color="ink.700">
          {data.summary.unmapped_lateral_spots} spots have unreliable transverse coordinates near a pole or boundary.
          They remain in the longitudinal distribution, cell rows and CSV, but are omitted from the 2D map.
        </Text>}
        <Box bg="sand.50" borderWidth="1px" borderColor="sand.200" borderRadius="lg" overflowX="auto">
          <svg viewBox="0 0 1000 245" style={{ width: '100%', minWidth: 550, display: 'block' }} role="img" aria-label="GFP position distribution">
            <text x="75" y="25" fontSize="18" fill="currentColor">{frequency === 'cells' ? 'Cells with a spot per bin (%)' : 'Spots per bin'}</text>
            {bins.map((value, index) => <g key={index}>
              <rect data-testid={`position-bin-${index}`} data-value={value}
                x={LEFT + index * (RIGHT - LEFT) / bins.length + 1} y={175 - value / maxBin * 120}
                width={(RIGHT - LEFT) / bins.length - 2} height={value / maxBin * 120} fill="#168477">
                <title>{value.toFixed(1)}{frequency === 'cells' ? '% of analyzed cells' : ' spots'}</title>
              </rect>
              {value > 0 && <text x={LEFT + (index + 0.5) * (RIGHT - LEFT) / bins.length}
                y={170 - value / maxBin * 120} textAnchor="middle" fontSize="12" fill="currentColor">{Number(value.toFixed(1))}</text>}
            </g>)}
            <line x1={LEFT} x2={RIGHT} y1="175" y2="175" stroke="#849b9d" />
            {ticks.map((tick) => <text key={tick} x={LEFT + tick * (RIGHT - LEFT)} y="198" textAnchor="middle" fontSize="14" fill="currentColor">{tick * axisMaximum(axis) * 100}%</text>)}
            <text x="510" y="228" textAnchor="middle" fontSize="14" fill="currentColor">{axisLabel(axis)}</text>
          </svg>
        </Box>
        <HStack justify="space-between" flexWrap="wrap">
          <Text fontWeight="600">One row per cell · full length, unassigned poles</Text>
          <HStack><Button size="xs" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous cells</Button>
            <Text fontSize="xs">{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.cells.length)} / {data.cells.length}</Text>
            <Button size="xs" disabled={(page + 1) * PAGE_SIZE >= data.cells.length} onClick={() => setPage(page + 1)}>Next cells</Button></HStack>
        </HStack>
        <Text fontSize="xs" color="ink.700">Each row retains all spots in that cell, so one-pole and two-pole patterns remain distinguishable. Click a cell to inspect it.</Text>
        <Box borderWidth="1px" borderColor="sand.200" borderRadius="md" p="3">
          <HStack ml="5.5rem" mr="5.5rem" justify="space-between"><Text fontSize="xs">0%</Text><Text fontSize="xs">50%</Text><Text fontSize="xs">100%</Text></HStack>
          {rows.map((cell) => <HStack key={cell.cell_id} gap="2" py="1" data-testid={`cell-row-${cell.cell_id}`}>
            <Button size="xs" variant="ghost" minW="5rem" onClick={() => setActiveCell(cell.cell_id)}>{cell.cell_id}</Button>
            {cell.status === 'ok' ? <>
              <svg style={{ flex: 1, width: '100%', minWidth: 70, height: 22 }} role="img" aria-label={`${cell.cell_id}: ${cell.spots.length} spots`}>
                <line x1="1%" x2="99%" y1="11" y2="11" stroke="#cad8d6" strokeWidth="4" />
                <line x1="50%" x2="50%" y1="2" y2="20" stroke="#b4c6c3" />
                {cell.spots.map((spot) => <circle key={spot.spot_id} cx={`${1 + spot.longitudinal * 98}%`} cy="11" r="4" fill="#168477">
                  <title>{(spot.longitudinal * 100).toFixed(1)}%</title></circle>)}
              </svg><Text fontSize="xs" w="5rem">{cell.spots.length} spots{cell.at_cap ? ' (cap)' : ''}</Text>
            </> : <Text fontSize="xs" color="ink.700">Skipped: {cell.error}</Text>}
          </HStack>)}
        </Box>
        {selected && <Box p="3" bg="sand.100" borderRadius="md">
          <HStack justify="space-between"><Text fontWeight="600">{selected.cell_id} · {selected.status === 'ok' ? `${selected.spots.length} spots` : selected.error}</Text>
            <Link to={`/cells?${new URLSearchParams({ db: dbName, cell_id: selected.cell_id })}`}>Open cell viewer ↗</Link></HStack>
          <HStack mt="2" gap="3" flexWrap="wrap">
            {(['ph', channel] as const).map((imageType) => <img key={imageType}
              src={`${apiBase}/get-cell-image?${new URLSearchParams({ dbname: dbName, cell_id: selected.cell_id, image_type: imageType, draw_contour: 'true' })}`}
              alt={`${selected.cell_id} ${imageType.toUpperCase()}`} style={{ width: 160, height: 160, objectFit: 'contain', borderRadius: 8 }} />)}
            {selected.settings && <Text fontSize="sm">Auto: σ {selected.settings.sigma_min.toFixed(2)}–{selected.settings.sigma_max.toFixed(2)} px,
              SNR ≥ {selected.settings.min_snr.toFixed(2)}. Length: {selected.length_px?.toFixed(1)} px.</Text>}
          </HStack>
        </Box>}
        {data.summary.at_cap_cells > 0 && <Text fontSize="xs" color="ink.700">{data.summary.at_cap_cells} cells reached the 10-spot limit. Additional accepted spots may have been omitted.</Text>}
      </>}
    </>}
  </Stack>
}
