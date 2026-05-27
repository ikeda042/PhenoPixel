import { useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import {
  AspectRatio,
  Badge,
  Box,
  BreadcrumbCurrentLink,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbRoot,
  BreadcrumbSeparator,
  Button,
  Container,
  Grid,
  Heading,
  HStack,
  NativeSelect,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react'
import { strFromU8, unzipSync } from 'fflate'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type BulkCell = {
  cellId: string
  label: string
  url: string
}

type ManifestEntry = {
  cell_id?: string
  label?: string
  file?: string
}

type CellLengthPair = {
  cell_id: string
  length: number
}

type CellAreaPair = {
  cell_id: string
  area: number
}

type NormalizedMedianPair = {
  cell_id: string
  normalized_median: number
}

type RawIntensityPair = {
  cell_id: string
  intensities: number[]
}

type HeatmapVectorPair = {
  cell_id: string
  u1: number[]
  g: number[]
}

type EntropyMetricsPair = {
  cell_id: string
  entropy_norm: number
  sparsity: number
}

const parseManifestEntries = (payload: unknown): ManifestEntry[] => {
  if (!payload || typeof payload !== 'object') return []
  const cells = (payload as { cells?: unknown }).cells
  if (!Array.isArray(cells)) return []
  return cells.filter((entry) => entry && typeof entry === 'object') as ManifestEntry[]
}

const parseCellLengthRows = (payload: unknown): CellLengthPair[] => {
  if (!Array.isArray(payload)) return []
  return payload
    .filter(
      (item): item is CellLengthPair =>
        item &&
        typeof item === 'object' &&
        typeof (item as CellLengthPair).cell_id === 'string' &&
        typeof (item as CellLengthPair).length === 'number' &&
        Number.isFinite((item as CellLengthPair).length),
    )
    .map((item) => ({
      cell_id: item.cell_id,
      length: item.length,
    }))
}

const normalizeLabel = (label: string) => {
  const trimmed = label.trim()
  if (!trimmed) return 'N/A'
  if (trimmed.toUpperCase() === 'N/A') return 'N/A'
  return trimmed
}

const isNumericLabel = (label: string) => /^\d+$/.test(label)

const sortLabels = (labels: string[]) =>
  [...labels].sort((a, b) => {
    if (a === 'N/A') return b === 'N/A' ? 0 : -1
    if (b === 'N/A') return 1
    const aNumeric = isNumericLabel(a)
    const bNumeric = isNumericLabel(b)
    if (aNumeric && bNumeric) return Number(a) - Number(b)
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a.localeCompare(b)
  })

const BULK_PREVIEW_DOWNSCALE_DEFAULT = 1
const BULK_PREVIEW_DOWNSCALE_OPTIONS = [
  { value: 0.5, label: 'Balanced (0.5x)' },
  { value: 0.75, label: 'High (0.75x)' },
  { value: 1, label: 'Full (1.0x)' },
]

export default function BulkEnginePage() {
  const [searchParams] = useSearchParams()
  const dbName = searchParams.get('dbname') ?? ''
  const apiBase = useMemo(() => getApiBase(), [])
  const bulkZoom = 0.75
  const scaledViewportHeight = `calc(100dvh / ${bulkZoom})`
  const fitcThreshold = 0.7414

  const [cells, setCells] = useState<BulkCell[]>([])
  const [previewCellId, setPreviewCellId] = useState<string | null>(null)
  const [previewOriginalUrl, setPreviewOriginalUrl] = useState<string | null>(null)
  const [previewOriginalError, setPreviewOriginalError] = useState<string | null>(null)
  const [isPreviewOriginalLoading, setIsPreviewOriginalLoading] = useState(false)
  const [previewDownscale, setPreviewDownscale] = useState(
    BULK_PREVIEW_DOWNSCALE_DEFAULT,
  )
  const [selectedLabel, setSelectedLabel] = useState('1')
  const [selectedChannel, setSelectedChannel] = useState('ph')
  const [isLoading, setIsLoading] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [analysisMode, setAnalysisMode] = useState('cell-length')
  const [analysisLabel, setAnalysisLabel] = useState('1')
  const [analysisChannel, setAnalysisChannel] = useState('ph')
  const [lengthPlotUrl, setLengthPlotUrl] = useState<string | null>(null)
  const [lengthError, setLengthError] = useState<string | null>(null)
  const [lengthDensityError, setLengthDensityError] = useState<string | null>(null)
  const [isLengthLoading, setIsLengthLoading] = useState(false)
  const [isLengthExporting, setIsLengthExporting] = useState(false)
  const [lengthExportError, setLengthExportError] = useState<string | null>(null)
  const [hasCalculatedLength, setHasCalculatedLength] = useState(false)
  const [lengthDensityValues, setLengthDensityValues] = useState<number[] | null>(null)
  const [areaPlotUrl, setAreaPlotUrl] = useState<string | null>(null)
  const [areaError, setAreaError] = useState<string | null>(null)
  const [isAreaLoading, setIsAreaLoading] = useState(false)
  const [isAreaExporting, setIsAreaExporting] = useState(false)
  const [areaExportError, setAreaExportError] = useState<string | null>(null)
  const [hasCalculatedArea, setHasCalculatedArea] = useState(false)
  const [medianPlotUrl, setMedianPlotUrl] = useState<string | null>(null)
  const [medianError, setMedianError] = useState<string | null>(null)
  const [isMedianLoading, setIsMedianLoading] = useState(false)
  const [isMedianExporting, setIsMedianExporting] = useState(false)
  const [medianExportError, setMedianExportError] = useState<string | null>(null)
  const [hasCalculatedMedian, setHasCalculatedMedian] = useState(false)
  const [fitcPlotUrl, setFitcPlotUrl] = useState<string | null>(null)
  const [fitcError, setFitcError] = useState<string | null>(null)
  const [isFitcLoading, setIsFitcLoading] = useState(false)
  const [hasCalculatedFitc, setHasCalculatedFitc] = useState(false)
  const [entropyPlotUrl, setEntropyPlotUrl] = useState<string | null>(null)
  const [entropyError, setEntropyError] = useState<string | null>(null)
  const [isEntropyLoading, setIsEntropyLoading] = useState(false)
  const [isEntropyExporting, setIsEntropyExporting] = useState(false)
  const [entropyExportError, setEntropyExportError] = useState<string | null>(null)
  const [hasCalculatedEntropy, setHasCalculatedEntropy] = useState(false)
  const [isRawExporting, setIsRawExporting] = useState(false)
  const [rawExportError, setRawExportError] = useState<string | null>(null)
  const [isHeatmapExporting, setIsHeatmapExporting] = useState(false)
  const [heatmapExportError, setHeatmapExportError] = useState<string | null>(null)
  const [isHeatmapPlotLoading, setIsHeatmapPlotLoading] = useState(false)
  const [heatmapPlotError, setHeatmapPlotError] = useState<string | null>(null)
  const [heatmapPlotUrl, setHeatmapPlotUrl] = useState<string | null>(null)
  const [isHeatmapRelLoading, setIsHeatmapRelLoading] = useState(false)
  const [heatmapRelError, setHeatmapRelError] = useState<string | null>(null)
  const [heatmapRelUrl, setHeatmapRelUrl] = useState<string | null>(null)
  const [isHuSeparationLoading, setIsHuSeparationLoading] = useState(false)
  const [huSeparationError, setHuSeparationError] = useState<string | null>(null)
  const [huSeparationUrl, setHuSeparationUrl] = useState<string | null>(null)
  const [isMap256Loading, setIsMap256Loading] = useState(false)
  const [map256Error, setMap256Error] = useState<string | null>(null)
  const [map256PlotUrl, setMap256PlotUrl] = useState<string | null>(null)
  const [map256PlotType, setMap256PlotType] = useState<'strip' | 'contour'>('strip')
  const [map256IntensityMode, setMap256IntensityMode] = useState<'absolute' | 'relative'>(
    'absolute',
  )
  const [hasCalculatedMap256, setHasCalculatedMap256] = useState(false)
  const [contoursPlotUrl, setContoursPlotUrl] = useState<string | null>(null)
  const [contoursError, setContoursError] = useState<string | null>(null)
  const [isContoursLoading, setIsContoursLoading] = useState(false)
  const [isContoursExporting, setIsContoursExporting] = useState(false)
  const [contoursExportError, setContoursExportError] = useState<string | null>(null)
  const [hasCalculatedContours, setHasCalculatedContours] = useState(false)
  const [jsonExportMode, setJsonExportMode] = useState<string | null>(null)
  const [jsonModal, setJsonModal] = useState<{ title: string; content: string } | null>(
    null,
  )
  const [jsonCopyStatus, setJsonCopyStatus] = useState<string | null>(null)
  const isJsonExporting = jsonExportMode !== null
  const activeUrlsRef = useRef<Set<string>>(new Set())
  const lengthPlotUrlRef = useRef<string | null>(null)
  const areaPlotUrlRef = useRef<string | null>(null)
  const medianPlotUrlRef = useRef<string | null>(null)
  const fitcPlotUrlRef = useRef<string | null>(null)
  const entropyPlotUrlRef = useRef<string | null>(null)
  const heatmapPlotUrlRef = useRef<string | null>(null)
  const heatmapRelUrlRef = useRef<string | null>(null)
  const huSeparationUrlRef = useRef<string | null>(null)
  const map256PlotUrlRef = useRef<string | null>(null)
  const contoursPlotUrlRef = useRef<string | null>(null)
  const previewOriginalUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!dbName) {
      setError('Database is required.')
      setCells([])
      setIsLoading(false)
      setPreviewCellId(null)
      return
    }

    let isActive = true
    const controller = new AbortController()

    const loadAnnotationZip = async () => {
      setIsLoading(true)
      setError(null)
      setSelectedLabel('1')
      setCells([])
      setPreviewCellId(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          image_type: selectedChannel,
          downscale: String(previewDownscale),
        })
        const res = await fetch(`${apiBase}/get-annotation-zip?${params.toString()}`, {
          headers: { accept: 'application/zip' },
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const buffer = await res.arrayBuffer()
        const zip = unzipSync(new Uint8Array(buffer))
        const manifestBytes = zip['manifest.json']
        if (!manifestBytes) {
          throw new Error('Manifest missing from zip')
        }
        const manifest = JSON.parse(strFromU8(manifestBytes)) as unknown
        const entries = parseManifestEntries(manifest)
        const nextCells: BulkCell[] = []

        for (const entry of entries) {
          const cellId = typeof entry.cell_id === 'string' ? entry.cell_id : ''
          const label = typeof entry.label === 'string' ? entry.label : ''
          const file = typeof entry.file === 'string' ? entry.file : ''
          if (!cellId || !file) continue
          const fileBytes = zip[file]
          if (!fileBytes) continue
          const blob = new Blob([fileBytes], { type: 'image/png' })
          const url = URL.createObjectURL(blob)
          nextCells.push({ cellId, label: normalizeLabel(label), url })
        }

        if (isActive) {
          setCells(nextCells)
        } else {
          nextCells.forEach((cell) => URL.revokeObjectURL(cell.url))
        }
      } catch (err) {
        if (isActive) {
          setError(err instanceof Error ? err.message : 'Failed to load annotation zip')
          setCells([])
        }
      } finally {
        if (isActive) setIsLoading(false)
      }
    }

    void loadAnnotationZip()
    return () => {
      isActive = false
      controller.abort()
    }
  }, [apiBase, dbName, selectedChannel, previewDownscale])

  useEffect(() => {
    const nextUrls = new Set(cells.map((cell) => cell.url))
    activeUrlsRef.current.forEach((url) => {
      if (!nextUrls.has(url)) {
        URL.revokeObjectURL(url)
      }
    })
    activeUrlsRef.current = nextUrls
  }, [cells])

  useEffect(() => {
    return () => {
      activeUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      activeUrlsRef.current.clear()
    }
  }, [])

  const labelOptions = useMemo(() => {
    const uniqueLabels = new Set([
      'N/A',
      '1',
      '2',
      '3',
      ...cells.map((cell) => cell.label),
    ])
    return ['All', ...sortLabels([...uniqueLabels])]
  }, [cells])

  const channelOptions = [
    { value: 'ph', label: 'ph' },
    { value: 'fluo1', label: 'fluo1' },
    { value: 'fluo2', label: 'fluo2' },
  ]
  const heatmapChannelOptions = channelOptions.filter(
    (option) => option.value !== 'ph',
  )

  const analysisLabelOptions = useMemo(() => {
    const baseLabels = labelOptions.filter((option) => option !== 'All')
    const unique = new Set(baseLabels)
    unique.add('1')
    const sorted = sortLabels([...unique])
    return ['All', ...sorted]
  }, [labelOptions])

  useEffect(() => {
    if (!labelOptions.includes(selectedLabel)) {
      setSelectedLabel('1')
    }
  }, [labelOptions, selectedLabel])

  useEffect(() => {
    if (!analysisLabelOptions.includes(analysisLabel)) {
      setAnalysisLabel('1')
    }
  }, [analysisLabelOptions, analysisLabel])

  useEffect(() => {
    if (
      (analysisMode === 'heatmap' ||
        analysisMode === 'map256' ||
        analysisMode === 'fitc-aggregation') &&
      analysisChannel === 'ph'
    ) {
      setAnalysisChannel('fluo1')
    }
  }, [analysisMode, analysisChannel])

  const escapeCsvValue = (value: string) => {
    if (/[",\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`
    }
    return value
  }

  const formatJsonString = (data: unknown) => {
    try {
      return JSON.stringify(data, null, 2) ?? ''
    } catch {
      return String(data)
    }
  }

  const openJsonModal = (title: string, data: unknown) => {
    setJsonModal({ title, content: formatJsonString(data) })
    setJsonCopyStatus(null)
  }

  const closeJsonModal = () => {
    setJsonModal(null)
    setJsonCopyStatus(null)
  }

  const handleCopyJson = async () => {
    if (!jsonModal?.content) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(jsonModal.content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = jsonModal.content
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(textarea)
        if (!copied) {
          throw new Error('Copy failed')
        }
      }
      setJsonCopyStatus('Copied to clipboard.')
    } catch {
      setJsonCopyStatus('Failed to copy.')
    }
  }

  const parseHeatmapVectorRows = (payload: unknown): HeatmapVectorPair[] => {
    if (!Array.isArray(payload)) return []
    return payload
      .filter(
        (item): item is HeatmapVectorPair =>
          item &&
          typeof item === 'object' &&
          typeof (item as HeatmapVectorPair).cell_id === 'string' &&
          Array.isArray((item as HeatmapVectorPair).u1) &&
          Array.isArray((item as HeatmapVectorPair).g) &&
          (item as HeatmapVectorPair).u1.every(
            (value) => typeof value === 'number' && Number.isFinite(value),
          ) &&
          (item as HeatmapVectorPair).g.every(
            (value) => typeof value === 'number' && Number.isFinite(value),
          ),
      )
      .map((item) => ({
        cell_id: item.cell_id,
        u1: item.u1,
        g: item.g,
      }))
  }

  const lengthDensityPlot = useMemo(() => {
    if (!lengthDensityValues || lengthDensityValues.length === 0) return null
    const values = lengthDensityValues.filter((value) => Number.isFinite(value))
    if (values.length === 0) return null

    const count = values.length
    const minValue = Math.min(...values)
    const maxValue = Math.max(...values)
    const mean = values.reduce((sum, value) => sum + value, 0) / count
    const variance =
      values.reduce((sum, value) => {
        const diff = value - mean
        return sum + diff * diff
      }, 0) / count
    const stdDev = Math.sqrt(Math.max(variance, 0))
    const range = Math.max(maxValue - minValue, Number.EPSILON)
    const fallbackBandwidth = Math.max(range / 20, Math.abs(mean) * 0.05, 0.05)
    let bandwidth = 1.06 * stdDev * Math.pow(count, -0.2)
    if (!Number.isFinite(bandwidth) || bandwidth <= 0) {
      bandwidth = fallbackBandwidth
    }

    const domainMin = Math.max(0, minValue - 3 * bandwidth)
    const domainMax = maxValue + 3 * bandwidth
    const span = Math.max(domainMax - domainMin, Number.EPSILON)
    const samples = 200
    const step = span / (samples - 1)
    const invSqrtTwoPi = 1 / Math.sqrt(2 * Math.PI)
    const points = Array.from({ length: samples }, (_, index) => {
      const x = domainMin + step * index
      let sum = 0
      for (const value of values) {
        const u = (x - value) / bandwidth
        sum += Math.exp(-0.5 * u * u)
      }
      const density = (sum * invSqrtTwoPi) / (count * bandwidth)
      return { x, density }
    })

    const maxDensity = Math.max(...points.map((point) => point.density), 0)
    if (!Number.isFinite(maxDensity) || maxDensity <= 0) return null

    const width = 760
    const height = 320
    const padding = { top: 16, right: 16, bottom: 46, left: 58 }
    const innerWidth = width - padding.left - padding.right
    const innerHeight = height - padding.top - padding.bottom
    const xToSvg = (value: number) =>
      padding.left + ((value - domainMin) / span) * innerWidth
    const yToSvg = (value: number) => padding.top + (1 - value / maxDensity) * innerHeight

    const path = points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'} ${xToSvg(point.x)} ${yToSvg(point.density)}`,
      )
      .join(' ')

    const leftX = xToSvg(domainMin)
    const rightX = xToSvg(domainMax)
    const baselineY = yToSvg(0)
    const areaPath = `${path} L ${rightX} ${baselineY} L ${leftX} ${baselineY} Z`

    const xTicks = Array.from({ length: 6 }, (_, index) => {
      const value = domainMin + (span * index) / 5
      return { value, position: xToSvg(value) }
    })
    const yTicks = Array.from({ length: 5 }, (_, index) => {
      const value = (maxDensity * (4 - index)) / 4
      return { value, position: yToSvg(value) }
    })

    return {
      width,
      height,
      padding,
      path,
      areaPath,
      baselineY,
      xTicks,
      yTicks,
      count,
    }
  }, [lengthDensityValues])

  const filteredCells = useMemo(() => {
    if (selectedLabel === 'All') return cells
    return cells.filter((cell) => cell.label === selectedLabel)
  }, [cells, selectedLabel])

  const previewCell = useMemo(() => {
    if (!previewCellId) return null
    return cells.find((cell) => cell.cellId === previewCellId) ?? null
  }, [cells, previewCellId])

  useEffect(() => {
    if (!previewCellId) return
    if (!previewCell) {
      setPreviewCellId(null)
    }
  }, [previewCell, previewCellId])

  useEffect(() => {
    const revokePreviewOriginalUrl = () => {
      if (previewOriginalUrlRef.current) {
        URL.revokeObjectURL(previewOriginalUrlRef.current)
        previewOriginalUrlRef.current = null
      }
    }

    if (!dbName || !previewCell) {
      setIsPreviewOriginalLoading(false)
      setPreviewOriginalError(null)
      setPreviewOriginalUrl(null)
      revokePreviewOriginalUrl()
      return
    }

    let isActive = true
    const controller = new AbortController()

    const loadPreviewOriginal = async () => {
      setIsPreviewOriginalLoading(true)
      setPreviewOriginalError(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: previewCell.cellId,
          image_type: selectedChannel,
          draw_contour: 'true',
        })
        const res = await fetch(`${apiBase}/get-cell-image?${params.toString()}`, {
          headers: { accept: 'image/png' },
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        if (!isActive) {
          URL.revokeObjectURL(url)
          return
        }
        revokePreviewOriginalUrl()
        previewOriginalUrlRef.current = url
        setPreviewOriginalUrl(url)
      } catch (err) {
        if (!isActive || controller.signal.aborted) return
        setPreviewOriginalError(
          err instanceof Error ? err.message : 'Failed to load full-resolution preview',
        )
        setPreviewOriginalUrl(null)
        revokePreviewOriginalUrl()
      } finally {
        if (isActive) setIsPreviewOriginalLoading(false)
      }
    }

    void loadPreviewOriginal()
    return () => {
      isActive = false
      controller.abort()
    }
  }, [apiBase, dbName, previewCell, selectedChannel])

  useEffect(() => {
    return () => {
      if (previewOriginalUrlRef.current) {
        URL.revokeObjectURL(previewOriginalUrlRef.current)
        previewOriginalUrlRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (lengthPlotUrlRef.current) {
      URL.revokeObjectURL(lengthPlotUrlRef.current)
      lengthPlotUrlRef.current = null
    }
    if (areaPlotUrlRef.current) {
      URL.revokeObjectURL(areaPlotUrlRef.current)
      areaPlotUrlRef.current = null
    }
    if (medianPlotUrlRef.current) {
      URL.revokeObjectURL(medianPlotUrlRef.current)
      medianPlotUrlRef.current = null
    }
    if (fitcPlotUrlRef.current) {
      URL.revokeObjectURL(fitcPlotUrlRef.current)
      fitcPlotUrlRef.current = null
    }
    if (entropyPlotUrlRef.current) {
      URL.revokeObjectURL(entropyPlotUrlRef.current)
      entropyPlotUrlRef.current = null
    }
    if (heatmapPlotUrlRef.current) {
      URL.revokeObjectURL(heatmapPlotUrlRef.current)
      heatmapPlotUrlRef.current = null
    }
    if (heatmapRelUrlRef.current) {
      URL.revokeObjectURL(heatmapRelUrlRef.current)
      heatmapRelUrlRef.current = null
    }
    if (huSeparationUrlRef.current) {
      URL.revokeObjectURL(huSeparationUrlRef.current)
      huSeparationUrlRef.current = null
    }
    if (map256PlotUrlRef.current) {
      URL.revokeObjectURL(map256PlotUrlRef.current)
      map256PlotUrlRef.current = null
    }
    if (contoursPlotUrlRef.current) {
      URL.revokeObjectURL(contoursPlotUrlRef.current)
      contoursPlotUrlRef.current = null
    }
    setLengthPlotUrl(null)
    setLengthError(null)
    setLengthDensityError(null)
    setLengthDensityValues(null)
    setLengthExportError(null)
    setAreaPlotUrl(null)
    setAreaError(null)
    setAreaExportError(null)
    setHasCalculatedLength(false)
    setHasCalculatedArea(false)
    setMedianPlotUrl(null)
    setMedianError(null)
    setMedianExportError(null)
    setHasCalculatedMedian(false)
    setFitcPlotUrl(null)
    setFitcError(null)
    setHasCalculatedFitc(false)
    setEntropyPlotUrl(null)
    setEntropyError(null)
    setEntropyExportError(null)
    setHasCalculatedEntropy(false)
    setRawExportError(null)
    setHeatmapExportError(null)
    setHeatmapPlotUrl(null)
    setHeatmapPlotError(null)
    setIsHeatmapPlotLoading(false)
    setHeatmapRelUrl(null)
    setHeatmapRelError(null)
    setIsHeatmapRelLoading(false)
    setHuSeparationUrl(null)
    setHuSeparationError(null)
    setIsHuSeparationLoading(false)
    setMap256PlotUrl(null)
    setMap256Error(null)
    setIsMap256Loading(false)
    setMap256PlotType('strip')
    setMap256IntensityMode('absolute')
    setHasCalculatedMap256(false)
    setContoursPlotUrl(null)
    setContoursError(null)
    setIsContoursLoading(false)
    setContoursExportError(null)
    setIsContoursExporting(false)
    setHasCalculatedContours(false)
    setJsonModal(null)
    setJsonCopyStatus(null)
    setJsonExportMode(null)
  }, [analysisMode, analysisLabel, analysisChannel, dbName])

  useEffect(() => {
    return () => {
      if (lengthPlotUrlRef.current) {
        URL.revokeObjectURL(lengthPlotUrlRef.current)
        lengthPlotUrlRef.current = null
      }
      if (areaPlotUrlRef.current) {
        URL.revokeObjectURL(areaPlotUrlRef.current)
        areaPlotUrlRef.current = null
      }
      if (medianPlotUrlRef.current) {
        URL.revokeObjectURL(medianPlotUrlRef.current)
        medianPlotUrlRef.current = null
      }
      if (fitcPlotUrlRef.current) {
        URL.revokeObjectURL(fitcPlotUrlRef.current)
        fitcPlotUrlRef.current = null
      }
      if (entropyPlotUrlRef.current) {
        URL.revokeObjectURL(entropyPlotUrlRef.current)
        entropyPlotUrlRef.current = null
      }
      if (heatmapPlotUrlRef.current) {
        URL.revokeObjectURL(heatmapPlotUrlRef.current)
        heatmapPlotUrlRef.current = null
      }
      if (heatmapRelUrlRef.current) {
        URL.revokeObjectURL(heatmapRelUrlRef.current)
        heatmapRelUrlRef.current = null
      }
      if (huSeparationUrlRef.current) {
        URL.revokeObjectURL(huSeparationUrlRef.current)
        huSeparationUrlRef.current = null
      }
      if (map256PlotUrlRef.current) {
        URL.revokeObjectURL(map256PlotUrlRef.current)
        map256PlotUrlRef.current = null
      }
      if (contoursPlotUrlRef.current) {
        URL.revokeObjectURL(contoursPlotUrlRef.current)
        contoursPlotUrlRef.current = null
      }
    }
  }, [])

  const handleCalcLength = async () => {
    if (!dbName || isLengthLoading) return
    setIsLengthLoading(true)
    setLengthError(null)
    setLengthDensityError(null)
    setLengthDensityValues(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const [plotRes, lengthsRes] = await Promise.all([
        fetch(`${apiBase}/get-cell-lengths-plot?${params.toString()}`, {
          headers: { accept: 'image/png' },
        }),
        fetch(`${apiBase}/get-cell-lengths?${params.toString()}`, {
          headers: { accept: 'application/json' },
        }),
      ])
      if (!plotRes.ok) {
        throw new Error(`Request failed (${plotRes.status})`)
      }
      const blob = await plotRes.blob()
      if (lengthPlotUrlRef.current) {
        URL.revokeObjectURL(lengthPlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      lengthPlotUrlRef.current = url
      setLengthPlotUrl(url)

      if (!lengthsRes.ok) {
        setLengthDensityError(`Failed to load density data (${lengthsRes.status})`)
      } else {
        const payload = (await lengthsRes.json()) as unknown
        const rows = parseCellLengthRows(payload)
        const values = rows.map((row) => row.length)
        if (values.length === 0) {
          setLengthDensityError('No lengths found for PDF plot.')
        } else {
          setLengthDensityValues(values)
        }
      }
      setHasCalculatedLength(true)
    } catch (err) {
      setLengthError(err instanceof Error ? err.message : 'Failed to calculate lengths')
      setLengthDensityError(null)
      setLengthDensityValues(null)
      setLengthPlotUrl(null)
      setHasCalculatedLength(true)
    } finally {
      setIsLengthLoading(false)
    }
  }

  const handleExportLengthCsv = async () => {
    if (!dbName || isLengthExporting) return
    setIsLengthExporting(true)
    setLengthExportError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const res = await fetch(`${apiBase}/get-cell-lengths?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      const rows = parseCellLengthRows(payload)
      if (rows.length === 0) {
        throw new Error('No lengths found for this label.')
      }
      const csvHeader = `cell_id,cell_length(\u03bcm)`
      const lines = [
        csvHeader,
        ...rows.map((row) => `${escapeCsvValue(row.cell_id)},${row.length}`),
      ]
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        analysisLabel === 'All'
          ? 'all'
          : analysisLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-cell-length.csv`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setLengthExportError(err instanceof Error ? err.message : 'Failed to export CSV')
    } finally {
      setIsLengthExporting(false)
    }
  }

  const handleExportLengthJson = async () => {
    if (!dbName || isJsonExporting) return
    setJsonExportMode('cell-length')
    setLengthExportError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const res = await fetch(`${apiBase}/get-cell-lengths?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      const rows = parseCellLengthRows(payload)
      if (rows.length === 0) {
        throw new Error('No lengths found for this label.')
      }
      const labelDescriptor = analysisLabel === 'All' ? 'all labels' : `label ${analysisLabel}`
      openJsonModal(`Cell length JSON (${labelDescriptor})`, rows)
    } catch (err) {
      setLengthExportError(err instanceof Error ? err.message : 'Failed to export JSON')
    } finally {
      setJsonExportMode(null)
    }
  }

  const handleCalcArea = async () => {
    if (!dbName || isAreaLoading) return
    setIsAreaLoading(true)
    setAreaError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const res = await fetch(`${apiBase}/get-cell-areas-plot?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (areaPlotUrlRef.current) {
        URL.revokeObjectURL(areaPlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      areaPlotUrlRef.current = url
      setAreaPlotUrl(url)
      setHasCalculatedArea(true)
    } catch (err) {
      setAreaError(err instanceof Error ? err.message : 'Failed to calculate areas')
      setAreaPlotUrl(null)
      setHasCalculatedArea(true)
    } finally {
      setIsAreaLoading(false)
    }
  }

  const handleCalcNormalizedMedian = async () => {
    if (!dbName || isMedianLoading) return
    setIsMedianLoading(true)
    setMedianError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-normalized-medians-plot?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (medianPlotUrlRef.current) {
        URL.revokeObjectURL(medianPlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      medianPlotUrlRef.current = url
      setMedianPlotUrl(url)
      setHasCalculatedMedian(true)
    } catch (err) {
      setMedianError(err instanceof Error ? err.message : 'Failed to calculate median')
      setMedianPlotUrl(null)
      setHasCalculatedMedian(true)
    } finally {
      setIsMedianLoading(false)
    }
  }

  const handleCalcFitcAggregation = async () => {
    if (!dbName || isFitcLoading) return
    setIsFitcLoading(true)
    setFitcError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-fitc-aggregation-plot?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (fitcPlotUrlRef.current) {
        URL.revokeObjectURL(fitcPlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      fitcPlotUrlRef.current = url
      setFitcPlotUrl(url)
      setHasCalculatedFitc(true)
    } catch (err) {
      setFitcError(err instanceof Error ? err.message : 'Failed to calculate FITC ratio')
      setFitcPlotUrl(null)
      setHasCalculatedFitc(true)
    } finally {
      setIsFitcLoading(false)
    }
  }

  const handleExportNormalizedMedianCsv = async () => {
    if (!dbName || isMedianExporting) return
    setIsMedianExporting(true)
    setMedianExportError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-normalized-medians?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is NormalizedMedianPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as NormalizedMedianPair).cell_id === 'string' &&
            typeof (item as NormalizedMedianPair).normalized_median === 'number',
        )
        .map((item) => ({
          cell_id: item.cell_id,
          normalized_median: item.normalized_median,
        }))
      if (rows.length === 0) {
        throw new Error('No values found for this label.')
      }
      const csvHeader = 'cell_id,normalized_median'
      const lines = [
        csvHeader,
        ...rows.map((row) => `${escapeCsvValue(row.cell_id)},${row.normalized_median}`),
      ]
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        analysisLabel === 'All'
          ? 'all'
          : analysisLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-normalized-median-${analysisChannel}.csv`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setMedianExportError(err instanceof Error ? err.message : 'Failed to export CSV')
    } finally {
      setIsMedianExporting(false)
    }
  }

  const handleExportNormalizedMedianJson = async () => {
    if (!dbName || isJsonExporting) return
    setJsonExportMode('normalized-median')
    setMedianExportError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-normalized-medians?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is NormalizedMedianPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as NormalizedMedianPair).cell_id === 'string' &&
            typeof (item as NormalizedMedianPair).normalized_median === 'number',
        )
        .map((item) => ({
          cell_id: item.cell_id,
          normalized_median: item.normalized_median,
        }))
      if (rows.length === 0) {
        throw new Error('No values found for this label.')
      }
      const labelDescriptor = analysisLabel === 'All' ? 'all labels' : `label ${analysisLabel}`
      openJsonModal(
        `Normalized median JSON (${labelDescriptor}, ${analysisChannel})`,
        rows,
      )
    } catch (err) {
      setMedianExportError(err instanceof Error ? err.message : 'Failed to export JSON')
    } finally {
      setJsonExportMode(null)
    }
  }

  const handleCalcEntropy = async () => {
    if (!dbName || isEntropyLoading) return
    setIsEntropyLoading(true)
    setEntropyError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-entropy-metrics-plot?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (entropyPlotUrlRef.current) {
        URL.revokeObjectURL(entropyPlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      entropyPlotUrlRef.current = url
      setEntropyPlotUrl(url)
      setHasCalculatedEntropy(true)
    } catch (err) {
      setEntropyError(err instanceof Error ? err.message : 'Failed to calculate entropy')
      setEntropyPlotUrl(null)
      setHasCalculatedEntropy(true)
    } finally {
      setIsEntropyLoading(false)
    }
  }

  const handleExportEntropyCsv = async () => {
    if (!dbName || isEntropyExporting) return
    setIsEntropyExporting(true)
    setEntropyExportError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-entropy-metrics?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is EntropyMetricsPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as EntropyMetricsPair).cell_id === 'string' &&
            typeof (item as EntropyMetricsPair).entropy_norm === 'number' &&
            typeof (item as EntropyMetricsPair).sparsity === 'number',
        )
        .map((item) => ({
          cell_id: item.cell_id,
          entropy_norm: item.entropy_norm,
          sparsity: item.sparsity,
        }))
      if (rows.length === 0) {
        throw new Error('No values found for this label.')
      }
      const csvHeader = 'cell_id,entropy_norm,sparsity'
      const lines = [
        csvHeader,
        ...rows.map(
          (row) =>
            `${escapeCsvValue(row.cell_id)},${row.entropy_norm},${row.sparsity}`,
        ),
      ]
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        analysisLabel === 'All'
          ? 'all'
          : analysisLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-entropy-${analysisChannel}.csv`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setEntropyExportError(err instanceof Error ? err.message : 'Failed to export CSV')
    } finally {
      setIsEntropyExporting(false)
    }
  }

  const handleExportEntropyJson = async () => {
    if (!dbName || isJsonExporting) return
    setJsonExportMode('entropy')
    setEntropyExportError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-entropy-metrics?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is EntropyMetricsPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as EntropyMetricsPair).cell_id === 'string' &&
            typeof (item as EntropyMetricsPair).entropy_norm === 'number' &&
            typeof (item as EntropyMetricsPair).sparsity === 'number',
        )
        .map((item) => ({
          cell_id: item.cell_id,
          entropy_norm: item.entropy_norm,
          sparsity: item.sparsity,
        }))
      if (rows.length === 0) {
        throw new Error('No values found for this label.')
      }
      const labelDescriptor = analysisLabel === 'All' ? 'all labels' : `label ${analysisLabel}`
      openJsonModal(`Entropy JSON (${labelDescriptor}, ${analysisChannel})`, rows)
    } catch (err) {
      setEntropyExportError(err instanceof Error ? err.message : 'Failed to export JSON')
    } finally {
      setJsonExportMode(null)
    }
  }

  const handleExportRawData = async () => {
    if (!dbName || isRawExporting) return
    setIsRawExporting(true)
    setRawExportError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-raw-intensities?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is RawIntensityPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as RawIntensityPair).cell_id === 'string' &&
            Array.isArray((item as RawIntensityPair).intensities),
        )
        .map((item) => ({
          cell_id: item.cell_id,
          intensities: item.intensities.filter(
            (value) => typeof value === 'number' && Number.isFinite(value),
          ),
        }))
      if (rows.length === 0) {
        throw new Error('No raw intensities found for this label.')
      }
      const lines = rows.map((row) =>
        [escapeCsvValue(row.cell_id), ...row.intensities.map((value) => String(value))].join(
          ',',
        ),
      )
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        analysisLabel === 'All'
          ? 'all'
          : analysisLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-raw-${analysisChannel}.csv`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setRawExportError(err instanceof Error ? err.message : 'Failed to export CSV')
    } finally {
      setIsRawExporting(false)
    }
  }

  const handleExportRawJson = async () => {
    if (!dbName || isJsonExporting) return
    setJsonExportMode('raw-data')
    setRawExportError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: analysisChannel,
      })
      const res = await fetch(`${apiBase}/get-raw-intensities?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is RawIntensityPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as RawIntensityPair).cell_id === 'string' &&
            Array.isArray((item as RawIntensityPair).intensities),
        )
        .map((item) => ({
          cell_id: item.cell_id,
          intensities: item.intensities.filter(
            (value) => typeof value === 'number' && Number.isFinite(value),
          ),
        }))
      if (rows.length === 0) {
        throw new Error('No raw intensities found for this label.')
      }
      const labelDescriptor = analysisLabel === 'All' ? 'all labels' : `label ${analysisLabel}`
      openJsonModal(`Raw intensity JSON (${labelDescriptor}, ${analysisChannel})`, rows)
    } catch (err) {
      setRawExportError(err instanceof Error ? err.message : 'Failed to export JSON')
    } finally {
      setJsonExportMode(null)
    }
  }

  const handleExportHeatmapCsv = async () => {
    if (!dbName || isHeatmapExporting) return
    setIsHeatmapExporting(true)
    setHeatmapExportError(null)
    try {
      const heatmapChannel = analysisChannel === 'ph' ? 'fluo1' : analysisChannel
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: heatmapChannel,
      })
      const res = await fetch(`${apiBase}/get-heatmap-vectors-csv?${params.toString()}`, {
        headers: { accept: 'text/csv' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (blob.size === 0) {
        throw new Error('No heatmap vectors found for this label.')
      }
      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        analysisLabel === 'All'
          ? 'all'
          : analysisLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-heatmap-${heatmapChannel}.csv`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setHeatmapExportError(err instanceof Error ? err.message : 'Failed to export CSV')
    } finally {
      setIsHeatmapExporting(false)
    }
  }

  const handleExportHeatmapJson = async () => {
    if (!dbName || isJsonExporting) return
    setJsonExportMode('heatmap')
    setHeatmapExportError(null)
    try {
      const heatmapChannel = analysisChannel === 'ph' ? 'fluo1' : analysisChannel
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: heatmapChannel,
      })
      const res = await fetch(`${apiBase}/get-heatmap-vectors?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json().catch(() => null)) as unknown
      const vectors = parseHeatmapVectorRows(payload)
      if (vectors.length === 0) {
        throw new Error('No heatmap vectors found for this label.')
      }
      const labelDescriptor = analysisLabel === 'All' ? 'all labels' : `label ${analysisLabel}`
      openJsonModal(`Heatmap vectors JSON (${labelDescriptor}, ${heatmapChannel})`, vectors)
    } catch (err) {
      setHeatmapExportError(err instanceof Error ? err.message : 'Failed to export JSON')
    } finally {
      setJsonExportMode(null)
    }
  }

  const handleGenerateHeatmapPlot = async () => {
    if (!dbName || isHeatmapPlotLoading) return
    setIsHeatmapPlotLoading(true)
    setHeatmapPlotError(null)
    try {
      const heatmapChannel = analysisChannel === 'ph' ? 'fluo1' : analysisChannel
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: heatmapChannel,
      })
      const res = await fetch(`${apiBase}/get-heatmap-abs-plot?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (blob.size === 0) {
        throw new Error('No heatmap vectors found for this label.')
      }
      if (heatmapPlotUrlRef.current) {
        URL.revokeObjectURL(heatmapPlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      heatmapPlotUrlRef.current = url
      setHeatmapPlotUrl(url)
    } catch (err) {
      setHeatmapPlotError(
        err instanceof Error ? err.message : 'Failed to generate heatmap plot',
      )
      setHeatmapPlotUrl(null)
    } finally {
      setIsHeatmapPlotLoading(false)
    }
  }

  const handleGenerateHeatmapRelPlot = async () => {
    if (!dbName || isHeatmapRelLoading) return
    setIsHeatmapRelLoading(true)
    setHeatmapRelError(null)
    try {
      const heatmapChannel = analysisChannel === 'ph' ? 'fluo1' : analysisChannel
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: heatmapChannel,
      })
      const res = await fetch(`${apiBase}/get-heatmap-rel-plot?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (blob.size === 0) {
        throw new Error('No heatmap vectors found for this label.')
      }
      if (heatmapRelUrlRef.current) {
        URL.revokeObjectURL(heatmapRelUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      heatmapRelUrlRef.current = url
      setHeatmapRelUrl(url)
    } catch (err) {
      setHeatmapRelError(
        err instanceof Error ? err.message : 'Failed to generate heatmap (rel) plot',
      )
      setHeatmapRelUrl(null)
    } finally {
      setIsHeatmapRelLoading(false)
    }
  }

  const handleGenerateHuSeparation = async () => {
    if (!dbName || isHuSeparationLoading) return
    setIsHuSeparationLoading(true)
    setHuSeparationError(null)
    try {
      const heatmapChannel = analysisChannel === 'ph' ? 'fluo1' : analysisChannel
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: heatmapChannel,
      })
      const res = await fetch(`${apiBase}/get-hu-separation-overlay?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (blob.size === 0) {
        throw new Error('No heatmap vectors found for this label.')
      }
      if (huSeparationUrlRef.current) {
        URL.revokeObjectURL(huSeparationUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      huSeparationUrlRef.current = url
      setHuSeparationUrl(url)
    } catch (err) {
      setHuSeparationError(
        err instanceof Error ? err.message : 'Failed to generate HU separation overlay',
      )
      setHuSeparationUrl(null)
    } finally {
      setIsHuSeparationLoading(false)
    }
  }

  const handleGenerateContoursGrid = async () => {
    if (!dbName || isContoursLoading) return
    setIsContoursLoading(true)
    setContoursError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const res = await fetch(`${apiBase}/get-contours-grid-plot?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (contoursPlotUrlRef.current) {
        URL.revokeObjectURL(contoursPlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      contoursPlotUrlRef.current = url
      setContoursPlotUrl(url)
      setHasCalculatedContours(true)
    } catch (err) {
      setContoursError(
        err instanceof Error ? err.message : 'Failed to generate contours grid',
      )
      setContoursPlotUrl(null)
      setHasCalculatedContours(true)
    } finally {
      setIsContoursLoading(false)
    }
  }

  const handleExportContoursJson = async () => {
    if (!dbName || isContoursExporting) return
    setIsContoursExporting(true)
    setContoursExportError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const res = await fetch(`${apiBase}/get-contours-grid-json?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (blob.size === 0) {
        throw new Error('No contours found for this label.')
      }
      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        analysisLabel === 'All'
          ? 'all'
          : analysisLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-contours.json`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setContoursExportError(
        err instanceof Error ? err.message : 'Failed to export contours JSON',
      )
    } finally {
      setIsContoursExporting(false)
    }
  }

  const generateMap256Plot = async (
    endpoint: 'get-map256-strip' | 'get-map256-contour',
    plotType: 'strip' | 'contour',
  ) => {
    if (!dbName) return
    setIsMap256Loading(true)
    setMap256Error(null)
    try {
      const mapChannel = analysisChannel === 'ph' ? 'fluo1' : analysisChannel
      const params = new URLSearchParams({
        dbname: dbName,
        label: analysisLabel,
        channel: mapChannel,
      })
      if (endpoint === 'get-map256-contour') {
        params.set('intensity_mode', map256IntensityMode)
      }
      const res = await fetch(`${apiBase}/${endpoint}?${params.toString()}`, {
        headers: { accept: 'image/png' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const blob = await res.blob()
      if (blob.size === 0) {
        throw new Error('No map256 data found for this label.')
      }
      if (map256PlotUrlRef.current) {
        URL.revokeObjectURL(map256PlotUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      map256PlotUrlRef.current = url
      setMap256PlotUrl(url)
      setMap256PlotType(plotType)
      setHasCalculatedMap256(true)
    } catch (err) {
      setMap256Error(err instanceof Error ? err.message : 'Failed to generate map256')
      setMap256PlotUrl(null)
      setHasCalculatedMap256(true)
    } finally {
      setIsMap256Loading(false)
    }
  }

  const handleGenerateMap256 = async () => {
    if (!dbName || isMap256Loading) return
    await generateMap256Plot('get-map256-strip', 'strip')
  }

  const handleGenerateMap256Contour = async () => {
    if (!dbName || isMap256Loading) return
    await generateMap256Plot('get-map256-contour', 'contour')
  }

  const handleExportAreaCsv = async () => {
    if (!dbName || isAreaExporting) return
    setIsAreaExporting(true)
    setAreaExportError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const res = await fetch(`${apiBase}/get-cell-areas?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is CellAreaPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as CellAreaPair).cell_id === 'string' &&
            typeof (item as CellAreaPair).area === 'number',
        )
        .map((item) => ({
          cell_id: item.cell_id,
          area: item.area,
        }))
      if (rows.length === 0) {
        throw new Error('No areas found for this label.')
      }
      const csvHeader = 'cell_id,cell_area(px^2)'
      const lines = [
        csvHeader,
        ...rows.map((row) => `${escapeCsvValue(row.cell_id)},${row.area}`),
      ]
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        analysisLabel === 'All'
          ? 'all'
          : analysisLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-cell-area.csv`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setAreaExportError(err instanceof Error ? err.message : 'Failed to export CSV')
    } finally {
      setIsAreaExporting(false)
    }
  }

  const handleExportAreaJson = async () => {
    if (!dbName || isJsonExporting) return
    setJsonExportMode('cell-area')
    setAreaExportError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName, label: analysisLabel })
      const res = await fetch(`${apiBase}/get-cell-areas?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json()) as unknown
      if (!Array.isArray(payload)) {
        throw new Error('Invalid response format')
      }
      const rows = payload
        .filter(
          (item): item is CellAreaPair =>
            item &&
            typeof item === 'object' &&
            typeof (item as CellAreaPair).cell_id === 'string' &&
            typeof (item as CellAreaPair).area === 'number',
        )
        .map((item) => ({
          cell_id: item.cell_id,
          area: item.area,
        }))
      if (rows.length === 0) {
        throw new Error('No areas found for this label.')
      }
      const labelDescriptor = analysisLabel === 'All' ? 'all labels' : `label ${analysisLabel}`
      openJsonModal(`Cell area JSON (${labelDescriptor})`, rows)
    } catch (err) {
      setAreaExportError(err instanceof Error ? err.message : 'Failed to export JSON')
    } finally {
      setJsonExportMode(null)
    }
  }

  const handleExport = async () => {
    if (isExporting || isLoading || filteredCells.length === 0) return
    setIsExporting(true)
    setExportError(null)
    const cleanupUrls: string[] = []
    try {
      let exportCells = filteredCells.map((cell) => ({ cellId: cell.cellId, url: cell.url }))
      if (selectedChannel === 'ph') {
        const params = new URLSearchParams({
          dbname: dbName,
          image_type: selectedChannel,
          raw: 'true',
        })
        const res = await fetch(`${apiBase}/get-annotation-zip?${params.toString()}`, {
          headers: { accept: 'application/zip' },
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const buffer = await res.arrayBuffer()
        const zip = unzipSync(new Uint8Array(buffer))
        const manifestBytes = zip['manifest.json']
        if (!manifestBytes) {
          throw new Error('Manifest missing from zip')
        }
        const manifest = JSON.parse(strFromU8(manifestBytes)) as unknown
        const entries = parseManifestEntries(manifest)
        const allowedIds = new Set(filteredCells.map((cell) => cell.cellId))
        const fileMap = new Map<string, Uint8Array>()
        for (const entry of entries) {
          const cellId = typeof entry.cell_id === 'string' ? entry.cell_id : ''
          const file = typeof entry.file === 'string' ? entry.file : ''
          if (!cellId || !file || !allowedIds.has(cellId)) continue
          const fileBytes = zip[file]
          if (!fileBytes) continue
          fileMap.set(cellId, fileBytes)
        }
        exportCells = filteredCells
          .map((cell) => {
            const fileBytes = fileMap.get(cell.cellId)
            if (!fileBytes) return null
            const blob = new Blob([fileBytes], { type: 'image/png' })
            const url = URL.createObjectURL(blob)
            cleanupUrls.push(url)
            return { cellId: cell.cellId, url }
          })
          .filter((cell): cell is { cellId: string; url: string } => Boolean(cell))
      }
      if (exportCells.length === 0) {
        throw new Error('No images found for export')
      }

      const imagePromises = exportCells.map(
        (cell) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image()
            img.decoding = 'async'
            img.onload = () => resolve(img)
            img.onerror = () => reject(new Error(`Failed to load ${cell.cellId}`))
            img.src = cell.url
          }),
      )
      const images = await Promise.all(imagePromises)
      const cellSize = Math.max(
        ...images.map((img) => Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height)),
      )
      const columns = Math.ceil(Math.sqrt(images.length))
      const rows = Math.ceil(images.length / columns)
      const canvas = document.createElement('canvas')
      canvas.width = columns * cellSize
      canvas.height = rows * cellSize
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        throw new Error('Canvas is not supported in this browser')
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      images.forEach((img, index) => {
        const col = index % columns
        const row = Math.floor(index / columns)
        const width = img.naturalWidth || img.width
        const height = img.naturalHeight || img.height
        const offsetX = col * cellSize + Math.floor((cellSize - width) / 2)
        const offsetY = row * cellSize + Math.floor((cellSize - height) / 2)
        ctx.drawImage(img, offsetX, offsetY)
      })

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((nextBlob) => {
          if (!nextBlob) {
            reject(new Error('Failed to export image'))
            return
          }
          resolve(nextBlob)
        }, 'image/png')
      })

      const safeDb = (dbName || 'db').replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const safeLabel =
        selectedLabel === 'All'
          ? 'all'
          : selectedLabel.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `bulk-${safeDb}-${safeLabel}-${selectedChannel}.png`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      cleanupUrls.forEach((url) => URL.revokeObjectURL(url))
      setIsExporting(false)
    }
  }

  const gridColumns = {
    base: 'repeat(2, minmax(0, 1fr))',
    md: 'repeat(4, minmax(0, 1fr))',
    lg: 'repeat(7, minmax(0, 1fr))',
  }

  return (
    <Box
      minH={{ base: '100dvh', lg: scaledViewportHeight }}
      h={{ base: 'auto', lg: scaledViewportHeight }}
      bg="sand.50"
      color="ink.900"
      display="flex"
      flexDirection="column"
      overflow={{ base: 'visible', lg: 'auto' }}
      style={{ zoom: bulkZoom }}
    >
      <PageHeader
        actions={
          <>
            <ReloadButton />
            <ThemeToggleButton />
          </>
        }
      />

      <Container
        maxW="96rem"
        py={{ base: 6, md: 8, lg: 4 }}
        flex="1"
        display="flex"
        flexDirection="column"
        minH="0"
      >
        <PageBreadcrumb>
          <BreadcrumbRoot fontSize="sm" color="ink.700">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink as={RouterLink} to="/">
                  Dashboard
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbLink as={RouterLink} to="/databases">
                  Databases
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbCurrentLink color="ink.900">Bulk Engine</BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>
        <Stack spacing={{ base: 5, lg: 4 }} flex="1" minH="0">
          <HStack justify="space-between" flexWrap="wrap" gap="3">
            <Text fontSize="sm" color="ink.700">
              Database: {dbName || 'Not selected'}
            </Text>
            <Text fontSize="xs" color="ink.700">
              Showing {filteredCells.length} / {cells.length}
            </Text>
          </HStack>

          {isLoading && (
            <HStack spacing="3" color="ink.700">
              <Spinner size="sm" />
              <Text fontSize="sm">Generating images...</Text>
            </HStack>
          )}

          {!isLoading && error && (
            <Text fontSize="sm" color="violet.300">
              {error}
            </Text>
          )}

          {!isLoading && !error && cells.length === 0 && (
            <Text fontSize="sm" color="ink.700">
              No annotation images found.
            </Text>
          )}

          {!isLoading && !error && cells.length > 0 && (
            <Grid
              templateColumns={{ base: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }}
              templateRows={{ base: 'auto', lg: 'minmax(0, 1fr)' }}
              gap="6"
              alignItems="start"
              flex="1"
              minH="0"
              h={{ base: 'auto', lg: '100%' }}
            >
              <Box
                bg="sand.100"
                border="1px solid"
                borderColor="sand.200"
                borderRadius="xl"
                p={{ base: 3, md: 4 }}
                display="flex"
                flexDirection="column"
                minH="0"
                h={{ base: 'auto', lg: '100%' }}
              >
                <HStack justify="space-between" flexWrap="wrap" gap="3" mb="4">
                  <HStack spacing="2">
                    <Badge
                      bg="sand.200"
                      color="ink.700"
                      borderRadius="full"
                      px="2"
                      py="1"
                      fontSize="0.6rem"
                      letterSpacing="0.18em"
                      textTransform="uppercase"
                    >
                      Cells
                    </Badge>
                    <Text fontSize="xs" color="ink.700">
                      Preview panel
                    </Text>
                    <Text fontSize="xs" color="ink.700">
                      Filter by manual label
                    </Text>
                  </HStack>
                  <HStack spacing="4" align="flex-start" flexWrap="wrap">
                    <Box minW="12rem">
                      <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                        Manual label
                      </Text>
                      <Stack spacing="1">
                        <NativeSelect.Root>
                          <NativeSelect.Field
                            value={selectedLabel}
                            onChange={(event) => setSelectedLabel(event.target.value)}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="sm"
                            h="2.25rem"
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            {labelOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                        <Text fontSize="xs" color="ink.700">
                          Cells: {filteredCells.length}
                        </Text>
                      </Stack>
                    </Box>
                    <Box minW="10rem">
                      <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                        Channel
                      </Text>
                      <Stack spacing="1">
                        <NativeSelect.Root>
                          <NativeSelect.Field
                            value={selectedChannel}
                            onChange={(event) => setSelectedChannel(event.target.value)}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="sm"
                            h="2.25rem"
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            {channelOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                        <Text fontSize="xs" color="ink.700">
                          Channel: {selectedChannel}
                        </Text>
                      </Stack>
                    </Box>
                    <Box minW="11rem">
                      <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                        Quality (PH)
                      </Text>
                      <Stack spacing="1">
                        <NativeSelect.Root>
                          <NativeSelect.Field
                            value={String(previewDownscale)}
                            onChange={(event) => {
                              const next = Number(event.target.value)
                              setPreviewDownscale(
                                Number.isFinite(next)
                                  ? next
                                  : BULK_PREVIEW_DOWNSCALE_DEFAULT,
                              )
                            }}
                            isDisabled={selectedChannel !== 'ph'}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="sm"
                            h="2.25rem"
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            {BULK_PREVIEW_DOWNSCALE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                        <Text fontSize="xs" color="ink.700">
                          {selectedChannel === 'ph'
                            ? `Scale: ${previewDownscale.toFixed(2)}x`
                            : 'Applied only to PH'}
                        </Text>
                      </Stack>
                    </Box>
                    <Box>
                      <Text
                        fontSize="xs"
                        letterSpacing="0.18em"
                        color="ink.700"
                        mb="1"
                        visibility="hidden"
                      >
                        Export
                      </Text>
                      <Button
                        size="sm"
                        h="2.25rem"
                        bg="tide.500"
                        color="white"
                        _hover={{ bg: 'tide.400' }}
                        onClick={handleExport}
                        isDisabled={filteredCells.length === 0 || isLoading || isExporting}
                        opacity={filteredCells.length === 0 ? 0.5 : 1}
                      >
                        {isExporting ? 'Exporting...' : 'Export'}
                      </Button>
                    </Box>
                  </HStack>
                </HStack>
                {exportError && (
                  <Text fontSize="xs" color="violet.300" mb="3">
                    {exportError}
                  </Text>
                )}

                <Box
                  flex="1"
                  minH="0"
                  overflowY={{ base: 'visible', lg: 'auto' }}
                  maxH="100%"
                  pr={{ base: 0, lg: 1 }}
                >
                  {filteredCells.length === 0 ? (
                    <Text fontSize="sm" color="ink.700">
                      No cells match this label.
                    </Text>
                  ) : (
                    <Grid templateColumns={gridColumns} gap="2" pb="1">
                      {filteredCells.map((cell) => (
                        <Box
                          key={cell.cellId}
                          bg="sand.50"
                          borderRadius="md"
                          p="1"
                          borderWidth="1px"
                          borderColor="sand.200"
                          cursor="pointer"
                          role="button"
                          tabIndex={0}
                          onClick={() => setPreviewCellId(cell.cellId)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setPreviewCellId(cell.cellId)
                            }
                          }}
                          _hover={{ borderColor: 'tide.400', boxShadow: 'sm' }}
                          _focusVisible={{ outline: '2px solid', outlineColor: 'tide.400' }}
                        >
                          <AspectRatio ratio={1}>
                            <Box
                              as="img"
                              src={cell.url}
                              alt={`Cell ${cell.cellId}`}
                              objectFit="cover"
                              borderRadius="sm"
                            />
                          </AspectRatio>
                          <Text fontSize="0.6rem" mt="1" color="ink.700" textAlign="center">
                            {cell.cellId}
                          </Text>
                        </Box>
                      ))}
                    </Grid>
                  )}
                </Box>
              </Box>

              <Box
                bg="sand.100"
                border="1px solid"
                borderColor="sand.200"
                borderRadius="xl"
                p={{ base: 3, md: 4 }}
                minH={{ base: '240px', lg: '0' }}
                display="flex"
                flexDirection="column"
                h={{ base: 'auto', lg: '100%' }}
              >
                <Badge
                  bg="sand.200"
                  color="ink.700"
                  borderRadius="full"
                  px="2"
                  py="1"
                  fontSize="0.6rem"
                  letterSpacing="0.18em"
                  textTransform="uppercase"
                >
                  Bulk Engine
                </Badge>
                <Box
                  flex="1"
                  minH="0"
                  overflowY={{ base: 'visible', lg: 'auto' }}
                  pr={{ base: 0, lg: 1 }}
                >
                  <Text fontSize="xs" color="ink.700" mt="3">
                    Analysis mode
                  </Text>
                  <Stack spacing="3" mt="2">
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={analysisMode}
                        onChange={(event) => setAnalysisMode(event.target.value)}
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        fontSize="sm"
                        h="2.25rem"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        <option value="cell-length">Cell length</option>
                        <option value="cell-area">Cell area</option>
                        <option value="normalized-median">Normalized median</option>
                        <option value="fitc-aggregation">FITC aggregation ratio</option>
                        <option value="entropy">Entropy</option>
                        <option value="heatmap">Heatmap</option>
                        <option value="contours">Contours</option>
                        <option value="map256">Map256</option>
                        <option value="raw-data">Raw data</option>
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </Stack>
                  <Text fontSize="xs" color="ink.700" mt="4">
                    Parameter settings
                  </Text>
                  {analysisMode === 'cell-length' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Cell length (um)
                      </Text>
                      <Box maxW="12rem">
                        <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                          Manual label
                        </Text>
                        <NativeSelect.Root>
                          <NativeSelect.Field
                            value={analysisLabel}
                            onChange={(event) => setAnalysisLabel(event.target.value)}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="sm"
                            h="2.25rem"
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            {analysisLabelOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                      </Box>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleCalcLength}
                          isDisabled={!dbName || isLengthLoading}
                        >
                          {isLengthLoading ? 'Calculating...' : 'Calc length'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportLengthCsv}
                          isDisabled={!dbName || isLengthExporting}
                        >
                          {isLengthExporting ? 'Exporting...' : 'Export CSV'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportLengthJson}
                          isDisabled={!dbName || isJsonExporting || isLengthExporting}
                        >
                          {jsonExportMode === 'cell-length' ? 'Exporting...' : 'Export JSON'}
                        </Button>
                      </HStack>
                      {lengthExportError && (
                        <Text fontSize="xs" color="violet.300">
                          {lengthExportError}
                        </Text>
                      )}
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Result
                      </Text>
                      {lengthError && (
                        <Text fontSize="xs" color="violet.300">
                          {lengthError}
                        </Text>
                      )}
                      {!lengthError && hasCalculatedLength && !lengthPlotUrl && (
                        <Text fontSize="sm" color="ink.700">
                          No lengths found for this label.
                        </Text>
                      )}
                      {lengthPlotUrl && (
                        <Stack spacing="3">
                          <Box
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            borderRadius="md"
                            p="2"
                          >
                            <Box
                              as="img"
                              src={lengthPlotUrl}
                              alt="Cell length boxplot"
                              width="100%"
                              height="auto"
                            />
                          </Box>
                          {lengthDensityError && (
                            <Text fontSize="xs" color="violet.300">
                              {lengthDensityError}
                            </Text>
                          )}
                          {lengthDensityPlot && (
                            <Box
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              borderRadius="md"
                              p="2"
                            >
                              <HStack justify="space-between" mb="1">
                                <Text fontSize="xs" color="ink.700" fontWeight="600">
                                  Probability density function
                                </Text>
                                <Text fontSize="xs" color="ink.700">
                                  n = {lengthDensityPlot.count}
                                </Text>
                              </HStack>
                              <AspectRatio ratio={16 / 7}>
                                <svg
                                  width="100%"
                                  height="100%"
                                  viewBox={`0 0 ${lengthDensityPlot.width} ${lengthDensityPlot.height}`}
                                  preserveAspectRatio="none"
                                >
                                  {lengthDensityPlot.yTicks.map((tick) => (
                                    <line
                                      key={`y-grid-${tick.value}`}
                                      x1={lengthDensityPlot.padding.left}
                                      x2={
                                        lengthDensityPlot.width - lengthDensityPlot.padding.right
                                      }
                                      y1={tick.position}
                                      y2={tick.position}
                                      stroke="var(--chakra-colors-sand-300)"
                                      strokeWidth="1"
                                    />
                                  ))}
                                  {lengthDensityPlot.xTicks.map((tick) => (
                                    <line
                                      key={`x-grid-${tick.value}`}
                                      x1={tick.position}
                                      x2={tick.position}
                                      y1={lengthDensityPlot.padding.top}
                                      y2={lengthDensityPlot.baselineY}
                                      stroke="var(--chakra-colors-sand-200)"
                                      strokeWidth="1"
                                      strokeDasharray="2 4"
                                    />
                                  ))}
                                  <path
                                    d={lengthDensityPlot.areaPath}
                                    fill="var(--chakra-colors-tide-400)"
                                    fillOpacity="0.16"
                                  />
                                  <path
                                    d={lengthDensityPlot.path}
                                    fill="none"
                                    stroke="var(--chakra-colors-tide-400)"
                                    strokeWidth="3"
                                  />
                                  <line
                                    x1={lengthDensityPlot.padding.left}
                                    x2={lengthDensityPlot.width - lengthDensityPlot.padding.right}
                                    y1={lengthDensityPlot.baselineY}
                                    y2={lengthDensityPlot.baselineY}
                                    stroke="var(--chakra-colors-ink-700)"
                                    strokeWidth="1.5"
                                  />
                                  <line
                                    x1={lengthDensityPlot.padding.left}
                                    x2={lengthDensityPlot.padding.left}
                                    y1={lengthDensityPlot.padding.top}
                                    y2={lengthDensityPlot.baselineY}
                                    stroke="var(--chakra-colors-ink-700)"
                                    strokeWidth="1.5"
                                  />
                                  {lengthDensityPlot.xTicks.map((tick) => (
                                    <text
                                      key={`x-label-${tick.value}`}
                                      x={tick.position}
                                      y={lengthDensityPlot.height - 16}
                                      textAnchor="middle"
                                      fontSize="12"
                                      fill="var(--chakra-colors-ink-700)"
                                    >
                                      {tick.value.toFixed(2)}
                                    </text>
                                  ))}
                                  {lengthDensityPlot.yTicks.map((tick) => (
                                    <text
                                      key={`y-label-${tick.value}`}
                                      x={lengthDensityPlot.padding.left - 6}
                                      y={tick.position + 4}
                                      textAnchor="end"
                                      fontSize="12"
                                      fill="var(--chakra-colors-ink-700)"
                                    >
                                      {tick.value >= 0.01
                                        ? tick.value.toFixed(2)
                                        : tick.value.toExponential(1)}
                                    </text>
                                  ))}
                                  <text
                                    x={lengthDensityPlot.width / 2}
                                    y={lengthDensityPlot.height - 2}
                                    textAnchor="middle"
                                    fontSize="13"
                                    fill="var(--chakra-colors-ink-700)"
                                  >
                                    Cell length (um)
                                  </text>
                                  <text
                                    x={14}
                                    y={lengthDensityPlot.height / 2}
                                    textAnchor="middle"
                                    fontSize="13"
                                    fill="var(--chakra-colors-ink-700)"
                                    transform={`rotate(-90 14 ${lengthDensityPlot.height / 2})`}
                                  >
                                    Probability density
                                  </text>
                                </svg>
                              </AspectRatio>
                            </Box>
                          )}
                        </Stack>
                      )}
                    </Stack>
                  )}
                  {analysisMode === 'cell-area' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Cell area (px^2)
                      </Text>
                      <Box maxW="12rem">
                        <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                          Manual label
                        </Text>
                        <NativeSelect.Root>
                          <NativeSelect.Field
                            value={analysisLabel}
                            onChange={(event) => setAnalysisLabel(event.target.value)}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="sm"
                            h="2.25rem"
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            {analysisLabelOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                      </Box>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleCalcArea}
                          isDisabled={!dbName || isAreaLoading}
                        >
                          {isAreaLoading ? 'Calculating...' : 'Calc area'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportAreaCsv}
                          isDisabled={!dbName || isAreaExporting}
                        >
                          {isAreaExporting ? 'Exporting...' : 'Export CSV'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportAreaJson}
                          isDisabled={!dbName || isJsonExporting || isAreaExporting}
                        >
                          {jsonExportMode === 'cell-area' ? 'Exporting...' : 'Export JSON'}
                        </Button>
                      </HStack>
                      {areaExportError && (
                        <Text fontSize="xs" color="violet.300">
                          {areaExportError}
                        </Text>
                      )}
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Result
                      </Text>
                      {areaError && (
                        <Text fontSize="xs" color="violet.300">
                          {areaError}
                        </Text>
                      )}
                      {!areaError && hasCalculatedArea && !areaPlotUrl && (
                        <Text fontSize="sm" color="ink.700">
                          No areas found for this label.
                        </Text>
                      )}
                      {areaPlotUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                        >
                          <Box
                            as="img"
                            src={areaPlotUrl}
                            alt="Cell area boxplot"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                    </Stack>
                  )}
                  {analysisMode === 'normalized-median' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Normalized median
                      </Text>
                      <HStack spacing="4" align="flex-start" flexWrap="wrap">
                        <Box maxW="12rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Manual label
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisLabel}
                              onChange={(event) => setAnalysisLabel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {analysisLabelOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                        <Box maxW="10rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Channel
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisChannel}
                              onChange={(event) => setAnalysisChannel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {channelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                        <Box maxW="12rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Contour intensity
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={map256IntensityMode}
                              onChange={(event) =>
                                setMap256IntensityMode(
                                  event.target.value as 'absolute' | 'relative',
                                )
                              }
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              <option value="absolute">absolute</option>
                              <option value="relative">relative</option>
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                      </HStack>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleCalcNormalizedMedian}
                          isDisabled={!dbName || isMedianLoading}
                        >
                          {isMedianLoading ? 'Calculating...' : 'Calc median'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportNormalizedMedianCsv}
                          isDisabled={!dbName || isMedianExporting}
                        >
                          {isMedianExporting ? 'Exporting...' : 'Export CSV'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportNormalizedMedianJson}
                          isDisabled={!dbName || isJsonExporting || isMedianExporting}
                        >
                          {jsonExportMode === 'normalized-median'
                            ? 'Exporting...'
                            : 'Export JSON'}
                        </Button>
                      </HStack>
                      {medianExportError && (
                        <Text fontSize="xs" color="violet.300">
                          {medianExportError}
                        </Text>
                      )}
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Result
                      </Text>
                      {medianError && (
                        <Text fontSize="xs" color="violet.300">
                          {medianError}
                        </Text>
                      )}
                      {!medianError && hasCalculatedMedian && !medianPlotUrl && (
                        <Text fontSize="sm" color="ink.700">
                          No values found for this label.
                        </Text>
                      )}
                      {medianPlotUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                        >
                          <Box
                            as="img"
                            src={medianPlotUrl}
                            alt="Normalized median boxplot"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                    </Stack>
                  )}
                  {analysisMode === 'fitc-aggregation' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        FITC aggregation ratio
                      </Text>
                      <HStack spacing="4" align="flex-start" flexWrap="wrap">
                        <Box maxW="12rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Manual label
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisLabel}
                              onChange={(event) => setAnalysisLabel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {analysisLabelOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                        <Box maxW="10rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Channel
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisChannel}
                              onChange={(event) => setAnalysisChannel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {heatmapChannelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                      </HStack>
                      <Text fontSize="xs" color="ink.700">
                        Threshold: {fitcThreshold}
                      </Text>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleCalcFitcAggregation}
                          isDisabled={!dbName || isFitcLoading}
                        >
                          {isFitcLoading ? 'Calculating...' : 'Calc ratio'}
                        </Button>
                      </HStack>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Result
                      </Text>
                      {fitcError && (
                        <Text fontSize="xs" color="violet.300">
                          {fitcError}
                        </Text>
                      )}
                      {!fitcError && hasCalculatedFitc && !fitcPlotUrl && (
                        <Text fontSize="sm" color="ink.700">
                          No values found for this label.
                        </Text>
                      )}
                      {fitcPlotUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                        >
                          <Box
                            as="img"
                            src={fitcPlotUrl}
                            alt="FITC aggregation ratio bar chart"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                    </Stack>
                  )}
                  {analysisMode === 'entropy' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Entropy / (1 - sparsity)
                      </Text>
                      <HStack spacing="4" align="flex-start" flexWrap="wrap">
                        <Box maxW="12rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Manual label
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisLabel}
                              onChange={(event) => setAnalysisLabel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {analysisLabelOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                        <Box maxW="10rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Channel
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisChannel}
                              onChange={(event) => setAnalysisChannel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {channelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                      </HStack>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleCalcEntropy}
                          isDisabled={!dbName || isEntropyLoading}
                        >
                          {isEntropyLoading ? 'Calculating...' : 'Calc entropy'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportEntropyCsv}
                          isDisabled={!dbName || isEntropyExporting}
                        >
                          {isEntropyExporting ? 'Exporting...' : 'Export CSV'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportEntropyJson}
                          isDisabled={!dbName || isJsonExporting || isEntropyExporting}
                        >
                          {jsonExportMode === 'entropy' ? 'Exporting...' : 'Export JSON'}
                        </Button>
                      </HStack>
                      {entropyExportError && (
                        <Text fontSize="xs" color="violet.300">
                          {entropyExportError}
                        </Text>
                      )}
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Result
                      </Text>
                      {entropyError && (
                        <Text fontSize="xs" color="violet.300">
                          {entropyError}
                        </Text>
                      )}
                      {!entropyError && hasCalculatedEntropy && !entropyPlotUrl && (
                        <Text fontSize="sm" color="ink.700">
                          No values found for this label.
                        </Text>
                      )}
                      {entropyPlotUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                        >
                          <Box
                            as="img"
                            src={entropyPlotUrl}
                            alt="Entropy / sparsity boxplot"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                    </Stack>
                  )}
                  {analysisMode === 'heatmap' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Heatmap vectors
                      </Text>
                      <HStack spacing="4" align="flex-start" flexWrap="wrap">
                        <Box maxW="12rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Manual label
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisLabel}
                              onChange={(event) => setAnalysisLabel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {analysisLabelOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                        <Box maxW="10rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Channel
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisChannel}
                              onChange={(event) => setAnalysisChannel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {heatmapChannelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                      </HStack>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportHeatmapCsv}
                          isDisabled={!dbName || isHeatmapExporting}
                        >
                          {isHeatmapExporting ? 'Exporting...' : 'Export CSV'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportHeatmapJson}
                          isDisabled={!dbName || isJsonExporting || isHeatmapExporting}
                        >
                          {jsonExportMode === 'heatmap' ? 'Exporting...' : 'Export JSON'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleGenerateHeatmapPlot}
                          isDisabled={!dbName || isHeatmapPlotLoading}
                        >
                          {isHeatmapPlotLoading ? 'Generating...' : 'Bulk heatmap'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleGenerateHeatmapRelPlot}
                          isDisabled={!dbName || isHeatmapRelLoading}
                        >
                          {isHeatmapRelLoading ? 'Generating...' : 'Heatmap (rel)'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleGenerateHuSeparation}
                          isDisabled={!dbName || isHuSeparationLoading}
                        >
                          {isHuSeparationLoading ? 'Generating...' : 'HU Separation'}
                        </Button>
                      </HStack>
                      {heatmapExportError && (
                        <Text fontSize="xs" color="violet.300">
                          {heatmapExportError}
                        </Text>
                      )}
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Output
                      </Text>
                      {heatmapPlotError && (
                        <Text fontSize="xs" color="violet.300">
                          {heatmapPlotError}
                        </Text>
                      )}
                      {heatmapRelError && (
                        <Text fontSize="xs" color="violet.300">
                          {heatmapRelError}
                        </Text>
                      )}
                      {huSeparationError && (
                        <Text fontSize="xs" color="violet.300">
                          {huSeparationError}
                        </Text>
                      )}
                      {heatmapPlotUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                          mt="2"
                        >
                          <Box
                            as="img"
                            src={heatmapPlotUrl}
                            alt="Bulk heatmap"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                      {heatmapRelUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                          mt="2"
                        >
                          <Box
                            as="img"
                            src={heatmapRelUrl}
                            alt="Bulk heatmap (rel)"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                      {huSeparationUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                          mt="2"
                        >
                          <Box
                            as="img"
                            src={huSeparationUrl}
                            alt="HU separation overlay"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                      <Text fontSize="sm" color="ink.700">
                        CSV rows are u1 and G vectors per cell for heatmap rendering.
                      </Text>
                    </Stack>
                  )}
                  {analysisMode === 'contours' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Contours grid
                      </Text>
                      <Box maxW="12rem">
                        <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                          Manual label
                        </Text>
                        <NativeSelect.Root>
                          <NativeSelect.Field
                            value={analysisLabel}
                            onChange={(event) => setAnalysisLabel(event.target.value)}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="sm"
                            h="2.25rem"
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            {analysisLabelOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                      </Box>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleGenerateContoursGrid}
                          isDisabled={!dbName || isContoursLoading}
                        >
                          {isContoursLoading ? 'Generating...' : 'Generate contours'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportContoursJson}
                          isDisabled={!dbName || isContoursExporting}
                        >
                          {isContoursExporting ? 'Exporting...' : 'Export JSON'}
                        </Button>
                      </HStack>
                      {contoursExportError && (
                        <Text fontSize="xs" color="violet.300">
                          {contoursExportError}
                        </Text>
                      )}
                      {contoursError && (
                        <Text fontSize="xs" color="violet.300">
                          {contoursError}
                        </Text>
                      )}
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Result
                      </Text>
                      {!contoursError && hasCalculatedContours && !contoursPlotUrl && (
                        <Text fontSize="sm" color="ink.700">
                          No contours found for this label.
                        </Text>
                      )}
                      {contoursPlotUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                        >
                          <Box
                            as="img"
                            src={contoursPlotUrl}
                            alt="Contours grid"
                            width="100%"
                            height="auto"
                          />
                        </Box>
                      )}
                    </Stack>
                  )}
                  {analysisMode === 'map256' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Map256 strip
                      </Text>
                      <HStack spacing="4" align="flex-start" flexWrap="wrap">
                        <Box maxW="12rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Manual label
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisLabel}
                              onChange={(event) => setAnalysisLabel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {analysisLabelOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                        <Box maxW="10rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Channel
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisChannel}
                              onChange={(event) => setAnalysisChannel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {heatmapChannelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                      </HStack>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleGenerateMap256}
                          isDisabled={!dbName || isMap256Loading}
                        >
                          {isMap256Loading ? 'Generating...' : 'Generate map256'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleGenerateMap256Contour}
                          isDisabled={!dbName || isMap256Loading}
                        >
                          {isMap256Loading ? 'Generating...' : 'Map256 (contour)'}
                        </Button>
                      </HStack>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Output
                      </Text>
                      {map256Error && (
                        <Text fontSize="xs" color="violet.300">
                          {map256Error}
                        </Text>
                      )}
                      {!map256Error && hasCalculatedMap256 && !map256PlotUrl && (
                        <Text fontSize="sm" color="ink.700">
                          No values found for this label.
                        </Text>
                      )}
                      {map256PlotUrl && (
                        <Box
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="2"
                          mt="2"
                          overflowX="auto"
                        >
                          <Box
                            as="img"
                            src={map256PlotUrl}
                            alt={map256PlotType === 'contour' ? 'Map256 contour' : 'Map256 strip'}
                            display="block"
                            maxW="none"
                            height="auto"
                          />
                        </Box>
                      )}
                    </Stack>
                  )}
                  {analysisMode === 'raw-data' && (
                    <Stack spacing="3" mt="2">
                      <Text fontSize="sm" fontWeight="600" color="ink.900">
                        Raw intensity data
                      </Text>
                      <HStack spacing="4" align="flex-start" flexWrap="wrap">
                        <Box maxW="12rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Manual label
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisLabel}
                              onChange={(event) => setAnalysisLabel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {analysisLabelOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                        <Box maxW="10rem">
                          <Text fontSize="xs" letterSpacing="0.18em" color="ink.700" mb="1">
                            Channel
                          </Text>
                          <NativeSelect.Root>
                            <NativeSelect.Field
                              value={analysisChannel}
                              onChange={(event) => setAnalysisChannel(event.target.value)}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              fontSize="sm"
                              h="2.25rem"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            >
                              {channelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator color="ink.700" />
                          </NativeSelect.Root>
                        </Box>
                      </HStack>
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Execution
                      </Text>
                      <HStack spacing="3" flexWrap="wrap">
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportRawData}
                          isDisabled={!dbName || isRawExporting}
                        >
                          {isRawExporting ? 'Exporting...' : 'Export CSV'}
                        </Button>
                        <Button
                          size="sm"
                          bg="tide.500"
                          color="white"
                          _hover={{ bg: 'tide.400' }}
                          onClick={handleExportRawJson}
                          isDisabled={!dbName || isJsonExporting || isRawExporting}
                        >
                          {jsonExportMode === 'raw-data' ? 'Exporting...' : 'Export JSON'}
                        </Button>
                      </HStack>
                      {rawExportError && (
                        <Text fontSize="xs" color="violet.300">
                          {rawExportError}
                        </Text>
                      )}
                      <Text fontSize="xs" color="ink.700" mt="3">
                        Output
                      </Text>
                      <Text fontSize="sm" color="ink.700">
                        One row per cell: cell_id followed by raw intensities inside the contour.
                      </Text>
                    </Stack>
                  )}
                </Box>
              </Box>
            </Grid>
          )}
        </Stack>
      </Container>
      {previewCell && (
        <Box
          position="fixed"
          inset="0"
          bg="rgba(11, 13, 16, 0.55)"
          zIndex={1450}
          display="flex"
          alignItems="center"
          justifyContent="center"
          px="4"
          onClick={() => setPreviewCellId(null)}
        >
          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            p={{ base: 3, md: 4 }}
            w="100%"
            maxW={{ base: '92vw', md: '640px' }}
            display="flex"
            flexDirection="column"
            gap="3"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <HStack justify="space-between" align="center" spacing="3" flexWrap="wrap">
              <Box>
                <Text fontSize="sm" fontWeight="600" color="ink.900">
                  Cell {previewCell.cellId}
                </Text>
                <Text fontSize="xs" color="ink.700">
                  Label: {previewCell.label}
                </Text>
              </Box>
              <Button
                size="xs"
                variant="outline"
                borderColor="tide.500"
                bg="tide.500"
                color="white"
                _hover={{ bg: 'tide.400' }}
                onClick={() => setPreviewCellId(null)}
              >
                Close
              </Button>
            </HStack>
            <Box display="flex" justifyContent="center">
              <Box w="min(82vw, 70vh)" maxW="520px">
                <AspectRatio ratio={1}>
                  <Box
                    as="img"
                    src={previewOriginalUrl ?? previewCell.url}
                    alt={`Cell ${previewCell.cellId}`}
                    objectFit="contain"
                    bg="sand.50"
                    borderRadius="md"
                  />
                </AspectRatio>
                {(isPreviewOriginalLoading || previewOriginalError) && (
                  <Text fontSize="xs" color="ink.700" textAlign="center" mt="2">
                    {isPreviewOriginalLoading
                      ? 'Loading original quality...'
                      : 'Original quality is unavailable. Showing preview image.'}
                  </Text>
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      )}
      {jsonModal && (
        <Box
          position="fixed"
          inset="0"
          bg="rgba(11, 13, 16, 0.55)"
          zIndex={1400}
          display="flex"
          alignItems="center"
          justifyContent="center"
          px="4"
          onClick={closeJsonModal}
        >
          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            p="4"
            w="100%"
            maxW={{ base: '90vw', md: '860px' }}
            maxH="80vh"
            display="flex"
            flexDirection="column"
            gap="3"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <HStack justify="space-between" align="center" spacing="3" flexWrap="wrap">
              <Text fontSize="sm" fontWeight="600" color="ink.900">
                {jsonModal.title}
              </Text>
              <HStack spacing="2">
                <Button
                  size="xs"
                  variant="outline"
                  borderColor="tide.500"
                  bg="tide.500"
                  color="white"
                  _hover={{ bg: 'tide.400' }}
                  onClick={handleCopyJson}
                >
                  Copy JSON
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  borderColor="tide.500"
                  bg="tide.500"
                  color="white"
                  _hover={{ bg: 'tide.400' }}
                  onClick={closeJsonModal}
                >
                  Close
                </Button>
              </HStack>
            </HStack>
            {jsonCopyStatus && (
              <Text
                fontSize="xs"
                color={jsonCopyStatus.startsWith('Failed') ? 'violet.300' : 'ink.700'}
              >
                {jsonCopyStatus}
              </Text>
            )}
            <Box
              as="pre"
              fontSize="xs"
              color="ink.700"
              bg="sand.50"
              border="1px solid"
              borderColor="sand.200"
              borderRadius="md"
              p="3"
              overflowY="auto"
              overflowX="auto"
              whiteSpace="pre"
              fontFamily="mono"
              flex="1"
            >
              {jsonModal.content || 'No data available.'}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}
