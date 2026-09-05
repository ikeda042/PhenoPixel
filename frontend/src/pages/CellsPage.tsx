import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import { strFromU8, unzipSync } from 'fflate'
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
  Checkbox,
  Grid,
  Heading,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Slider,
  Spinner,
  Stack,
  Switch,
  Text,
} from '@chakra-ui/react'
import { ArrowLeft, ArrowRight, Download } from 'lucide-react'
import CellsHelpDrawer from '../components/CellsHelpDrawer'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import PageContainer from '../components/PageContainer'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type ChannelKey = 'ph' | 'fluo1' | 'fluo2'
type ReplotChannel = ChannelKey | 'overlay'
type FluoColor = 'blue' | 'green' | 'red' | 'yellow' | 'magenta' | 'gray'
type OverlayOptions = {
  contour: boolean
  scale: boolean
}
type ChannelImageMap = Record<ChannelKey, string | null>
type ChannelMissingMap = Record<ChannelKey, boolean>
type FastBundleCell = {
  images: ChannelImageMap
  missingChannels: ChannelMissingMap
  manualLabel: string | null
}
type FastBundleState = Record<string, FastBundleCell>
type FastBundleManifestCell = {
  cell_id?: unknown
  manual_label?: unknown
  files?: Record<string, unknown>
  missing?: Record<string, unknown>
}
type FastBundleManifest = {
  cells?: FastBundleManifestCell[]
}

const channels: { key: ChannelKey; label: string }[] = [
  { key: 'ph', label: 'PH' },
  { key: 'fluo1', label: 'FLUO1' },
  { key: 'fluo2', label: 'FLUO2' },
]
const fluoColorOptions: { value: FluoColor; label: string }[] = [
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'magenta', label: 'Magenta' },
  { value: 'gray', label: 'Gray' },
]
const defaultFluoColors: Record<'fluo1' | 'fluo2', FluoColor> = {
  fluo1: 'green',
  fluo2: 'magenta',
}

const channelOptions: { value: ChannelKey; label: string }[] = [
  { value: 'ph', label: 'PH' },
  { value: 'fluo1', label: 'Fluo1' },
  { value: 'fluo2', label: 'Fluo2' },
]
const replotChannelOptions: { value: ReplotChannel; label: string }[] = [
  ...channelOptions,
  { value: 'overlay', label: 'Overlay' },
]

const LABEL_FILTER_OPTIONS = ['N/A', '1', '2', '3'] as const
const DEFAULT_LABEL_OPTIONS = ['All', ...LABEL_FILTER_OPTIONS]
const FAST_MODE_QUERY_VALUES = new Set(['1', 'true', 'yes', 'on'])
const DEFAULT_GAIN = 5
const EMPTY_IMAGES: ChannelImageMap = {
  ph: null,
  fluo1: null,
  fluo2: null,
}
const EMPTY_MISSING_CHANNELS: ChannelMissingMap = {
  ph: false,
  fluo1: false,
  fluo2: false,
}

const createEmptyImages = (): ChannelImageMap => ({ ...EMPTY_IMAGES })
const createEmptyMissingChannels = (): ChannelMissingMap => ({
  ...EMPTY_MISSING_CHANNELS,
})

const normalizeManualLabel = (label: string | null) => {
  const trimmed = (label ?? '').trim()
  return trimmed ? trimmed : null
}

const parseCellId = (cellId: string) => {
  const match = /^F(\d+)C(\d+)$/i.exec(cellId)
  if (!match) return null
  return { frame: Number(match[1]), cell: Number(match[2]) }
}

const sortCellIds = (ids: string[]) =>
  [...ids].sort((a, b) => {
    const parsedA = parseCellId(a)
    const parsedB = parseCellId(b)
    if (parsedA && parsedB) {
      if (parsedA.frame !== parsedB.frame) {
        return parsedA.frame - parsedB.frame
      }
      return parsedA.cell - parsedB.cell
    }
    if (parsedA) return -1
    if (parsedB) return 1
    return a.localeCompare(b)
  })

const toSafeFilenamePart = (value: string, fallback: string) => {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  const safe = trimmed.replace(/\.db$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return safe || fallback
}

export default function CellsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const dbName = searchParams.get('db') ?? ''
  const databasesPagePath = dbName
    ? `/databases?search_dbname=${encodeURIComponent(dbName)}`
    : '/databases'
  const requestedCellId = searchParams.get('cell_id') ?? searchParams.get('cell') ?? ''
  const fastModeParam = (searchParams.get('fast') ?? '').trim().toLowerCase()
  const fastModeRequested = FAST_MODE_QUERY_VALUES.has(fastModeParam)
  const apiBase = useMemo(() => getApiBase(), [])

  const [isHelpOpen, setIsHelpOpen] = useState(false)
  const [cellIds, setCellIds] = useState<string[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [manualLabel, setManualLabel] = useState<string | null>(null)
  const [isLoadingLabel, setIsLoadingLabel] = useState(false)
  const [isUpdatingLabel, setIsUpdatingLabel] = useState(false)
  const [manualLabelError, setManualLabelError] = useState<string | null>(null)
  const [labelOptions, setLabelOptions] = useState<string[]>(DEFAULT_LABEL_OPTIONS)
  const [selectedLabel, setSelectedLabel] = useState('All')
  const [overlayOptions, setOverlayOptions] = useState<OverlayOptions>({
    contour: true,
    scale: true,
  })
  const [fluoColors, setFluoColors] = useState<Record<'fluo1' | 'fluo2', FluoColor>>(
    defaultFluoColors,
  )
  const [contourMode, setContourMode] = useState<
    | 'contour'
    | 'replot'
    | 'overlay'
    | 'overlay-fluo'
    | 'overlay-raw'
    | 'heatmap'
    | 'distribution'
    | 'map256'
    | 'map-raw'
  >('overlay-fluo')
  const [contourData, setContourData] = useState<number[][]>([])
  const [isLoadingContour, setIsLoadingContour] = useState(false)
  const [contourError, setContourError] = useState<string | null>(null)
  const [replotUrl, setReplotUrl] = useState<string | null>(null)
  const [isLoadingReplot, setIsLoadingReplot] = useState(false)
  const [replotError, setReplotError] = useState<string | null>(null)
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null)
  const [isLoadingOverlay, setIsLoadingOverlay] = useState(false)
  const [overlayError, setOverlayError] = useState<string | null>(null)
  const [heatmapUrl, setHeatmapUrl] = useState<string | null>(null)
  const [isLoadingHeatmap, setIsLoadingHeatmap] = useState(false)
  const [heatmapError, setHeatmapError] = useState<string | null>(null)
  const [heatmapChannel, setHeatmapChannel] = useState<'fluo1' | 'fluo2'>('fluo1')
  const [map256Url, setMap256Url] = useState<string | null>(null)
  const [isLoadingMap256, setIsLoadingMap256] = useState(false)
  const [map256Error, setMap256Error] = useState<string | null>(null)
  const [map256Channel, setMap256Channel] = useState<'fluo1' | 'fluo2' | 'overlay'>(
    'fluo1',
  )
  const [map256JetUrl, setMap256JetUrl] = useState<string | null>(null)
  const [map256JetError, setMap256JetError] = useState<string | null>(null)
  const [distributionUrl, setDistributionUrl] = useState<string | null>(null)
  const [isLoadingDistribution, setIsLoadingDistribution] = useState(false)
  const [distributionError, setDistributionError] = useState<string | null>(null)
  const [distributionChannel, setDistributionChannel] = useState<ChannelKey>('fluo1')
  const [replotChannel, setReplotChannel] = useState<ReplotChannel>('fluo1')
  const [replotMesh, setReplotMesh] = useState(false)
  const [contourRefreshKey, setContourRefreshKey] = useState(0)
  const [modificationMode, setModificationMode] = useState<
    'elastic' | 'optical-boost' | 'gain'
  >('gain')
  const [elasticDelta, setElasticDelta] = useState(0)
  const [gainValue, setGainValue] = useState(DEFAULT_GAIN)
  const [gainInput, setGainInput] = useState(String(DEFAULT_GAIN))
  const [appliedGain, setAppliedGain] = useState(DEFAULT_GAIN)
  const [isApplyingModification, setIsApplyingModification] = useState(false)
  const [isApplyingBulkModification, setIsApplyingBulkModification] = useState(false)
  const [modificationError, setModificationError] = useState<string | null>(null)
  const [imageDimensions, setImageDimensions] = useState<{
    width: number
    height: number
  } | null>(null)
  const [images, setImages] = useState<ChannelImageMap>(createEmptyImages)
  const [missingChannels, setMissingChannels] = useState<ChannelMissingMap>(
    createEmptyMissingChannels,
  )
  const [fastBundle, setFastBundle] = useState<FastBundleState | null>(null)
  const [isLoadingFastBundle, setIsLoadingFastBundle] = useState(false)
  const [fastBundleError, setFastBundleError] = useState<string | null>(null)
  const [isLoadingIds, setIsLoadingIds] = useState(false)
  const [isLoadingImages, setIsLoadingImages] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentCellId = cellIds[currentIndex] ?? ''
  const cellCount = cellIds.length
  const restorePendingRef = useRef(false)
  const fastCell = useMemo(() => {
    if (!fastBundle || !currentCellId) return null
    return fastBundle[currentCellId] ?? null
  }, [currentCellId, fastBundle])
  const canUseFastImages = useMemo(
    () =>
      fastModeRequested &&
      selectedLabel === 'All' &&
      overlayOptions.contour &&
      overlayOptions.scale &&
      fluoColors.fluo1 === defaultFluoColors.fluo1 &&
      fluoColors.fluo2 === defaultFluoColors.fluo2 &&
      modificationMode === 'elastic' &&
      contourRefreshKey === 0 &&
      Boolean(fastCell),
    [
      contourRefreshKey,
      fastCell,
      fastModeRequested,
      fluoColors.fluo1,
      fluoColors.fluo2,
      modificationMode,
      overlayOptions.contour,
      overlayOptions.scale,
      selectedLabel,
    ],
  )
  const activeImages = canUseFastImages && fastCell ? fastCell.images : images
  const activeMissingChannels =
    canUseFastImages && fastCell ? fastCell.missingChannels : missingChannels
  const canUseFastLabels =
    fastModeRequested && selectedLabel === 'All' && Boolean(fastCell)

  const revokeFastBundleUrls = useCallback((bundle: FastBundleState | null) => {
    if (!bundle) return
    Object.values(bundle).forEach((cell) => {
      Object.values(cell.images).forEach((url) => {
        if (url) URL.revokeObjectURL(url)
      })
    })
  }, [])

  useEffect(() => {
    restorePendingRef.current = Boolean(requestedCellId)
  }, [requestedCellId, dbName])

  useEffect(() => {
    if (!requestedCellId || cellIds.length === 0) return
    const nextIndex = cellIds.indexOf(requestedCellId)
    if (nextIndex >= 0) {
      setCurrentIndex(nextIndex)
      return
    }
    restorePendingRef.current = false
  }, [cellIds, requestedCellId])

  useEffect(() => {
    if (restorePendingRef.current && requestedCellId && currentCellId === requestedCellId) {
      restorePendingRef.current = false
    }
  }, [currentCellId, requestedCellId])

  useEffect(() => {
    if (!dbName || !currentCellId) return
    if (restorePendingRef.current) return
    if (searchParams.get('cell_id') === currentCellId) return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('cell_id', currentCellId)
    nextParams.delete('cell')
    setSearchParams(nextParams, { replace: true })
  }, [currentCellId, dbName, searchParams, setSearchParams])

  const fetchLabelOptions = useCallback(async () => {
    setLabelOptions(DEFAULT_LABEL_OPTIONS)
  }, [])

  useEffect(() => {
    void fetchLabelOptions()
  }, [fetchLabelOptions])

  useEffect(() => {
    if (!labelOptions.includes(selectedLabel)) {
      setSelectedLabel('All')
    }
  }, [labelOptions, selectedLabel])

  useEffect(() => {
    if (!fastModeRequested || !dbName || selectedLabel !== 'All') {
      setIsLoadingFastBundle(false)
      return
    }
    let isActive = true
    const controller = new AbortController()

    const loadFastBundle = async () => {
      setIsLoadingFastBundle(true)
      setFastBundleError(null)
      setError(null)
      setCellIds([])
      setCurrentIndex(0)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          draw_contour: 'true',
          draw_scale_bar: 'true',
          fluo1_color: defaultFluoColors.fluo1,
          fluo2_color: defaultFluoColors.fluo2,
          gain: '1',
        })
        const res = await fetch(`${apiBase}/get-cells-fast-bundle?${params.toString()}`, {
          signal: controller.signal,
          headers: { accept: 'application/zip' },
        })
        if (!res.ok) {
          throw new Error(`Fast preload failed (${res.status})`)
        }
        const buffer = await res.arrayBuffer()
        const zipEntries = unzipSync(new Uint8Array(buffer))
        const manifestRaw = zipEntries['manifest.json']
        if (!manifestRaw) {
          throw new Error('Fast preload manifest is missing.')
        }
        const parsed = JSON.parse(strFromU8(manifestRaw)) as FastBundleManifest
        const manifestCells = Array.isArray(parsed.cells) ? parsed.cells : []
        const nextBundle: FastBundleState = {}
        const nextCellIds: string[] = []

        for (const entry of manifestCells) {
          if (typeof entry.cell_id !== 'string' || !entry.cell_id) continue
          const files = entry.files && typeof entry.files === 'object' ? entry.files : {}
          const missing =
            entry.missing && typeof entry.missing === 'object' ? entry.missing : {}
          const nextImages = createEmptyImages()
          const nextMissing = createEmptyMissingChannels()
          for (const channel of channels) {
            const filePath = files[channel.key]
            if (typeof filePath === 'string' && filePath) {
              const imageBytes = zipEntries[filePath]
              if (imageBytes) {
                nextImages[channel.key] = URL.createObjectURL(
                  new Blob([imageBytes], { type: 'image/png' }),
                )
              }
            }
            const missingValue = missing[channel.key]
            if (typeof missingValue === 'boolean') {
              nextMissing[channel.key] = missingValue
            } else if (!nextImages[channel.key]) {
              nextMissing[channel.key] = channel.key !== 'ph'
            }
          }

          nextBundle[entry.cell_id] = {
            images: nextImages,
            missingChannels: nextMissing,
            manualLabel: normalizeManualLabel(
              entry.manual_label == null ? null : String(entry.manual_label),
            ),
          }
          nextCellIds.push(entry.cell_id)
        }

        if (!isActive) {
          revokeFastBundleUrls(nextBundle)
          return
        }
        setFastBundle((previous) => {
          revokeFastBundleUrls(previous)
          return nextBundle
        })
        setCellIds(sortCellIds(nextCellIds))
        setCurrentIndex(0)
        setError(null)
      } catch (err) {
        if (!isActive) return
        setFastBundle((previous) => {
          revokeFastBundleUrls(previous)
          return null
        })
        setFastBundleError(
          err instanceof Error ? err.message : 'Failed to preload fast bundle',
        )
      } finally {
        if (isActive) {
          setIsLoadingFastBundle(false)
        }
      }
    }

    void loadFastBundle()
    return () => {
      isActive = false
      controller.abort()
    }
  }, [apiBase, dbName, fastModeRequested, revokeFastBundleUrls, selectedLabel])

  useEffect(() => {
    if (dbName) return
    setFastBundle((previous) => {
      revokeFastBundleUrls(previous)
      return null
    })
    setFastBundleError(null)
    setIsLoadingFastBundle(false)
  }, [dbName, revokeFastBundleUrls])

  const fetchCellIds = useCallback(async () => {
    if (!dbName) {
      setError('Database is required.')
      setCellIds([])
      setCurrentIndex(0)
      return
    }
    if (fastModeRequested && selectedLabel === 'All') {
      if (fastBundle) {
        const sortedFastIds = sortCellIds(Object.keys(fastBundle))
        setCellIds((prev) => {
          if (
            prev.length === sortedFastIds.length &&
            prev.every((value, index) => value === sortedFastIds[index])
          ) {
            return prev
          }
          return sortedFastIds
        })
        setCurrentIndex((prev) =>
          sortedFastIds.length === 0 ? 0 : Math.min(prev, sortedFastIds.length - 1),
        )
        setIsLoadingIds(false)
        return
      }
      if (isLoadingFastBundle || !fastBundleError) {
        setIsLoadingIds(false)
        return
      }
    }
    setIsLoadingIds(true)
    setError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName })
      const endpoint =
        selectedLabel === 'All' ? 'get-cell-ids' : 'get-cell-ids-by-label'
      if (selectedLabel !== 'All') {
        params.set('label', selectedLabel)
      }
      const res = await fetch(`${apiBase}/${endpoint}?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const data = (await res.json()) as string[]
      const sorted = sortCellIds(Array.isArray(data) ? data : [])
      setCellIds(sorted)
      setCurrentIndex(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cell IDs')
      setCellIds([])
    } finally {
      setIsLoadingIds(false)
    }
  }, [
    apiBase,
    dbName,
    fastBundle,
    fastBundleError,
    fastModeRequested,
    isLoadingFastBundle,
    selectedLabel,
  ])

  useEffect(() => {
    void fetchCellIds()
  }, [fetchCellIds])

  useEffect(() => {
    if (canUseFastImages && fastCell) {
      setIsLoadingImages(false)
      return
    }
    if (!dbName || !currentCellId) {
      setImages(createEmptyImages())
      setMissingChannels(createEmptyMissingChannels())
      return
    }

    let isActive = true
    const fetchChannel = async (
      channel: ChannelKey,
    ): Promise<{ url: string | null; missing: boolean }> => {
      const isFluo = channel === 'fluo1' || channel === 'fluo2'
      const endpoint =
        modificationMode === 'optical-boost' && isFluo
          ? 'get-cell-image-optical-boost'
          : 'get-cell-image'
      const params = new URLSearchParams({
        dbname: dbName,
        cell_id: currentCellId,
        image_type: channel,
        draw_contour: String(overlayOptions.contour),
        draw_scale_bar: String(overlayOptions.scale),
      })
      if (isFluo) {
        params.set('fluo_color', fluoColors[channel])
      }
      if (modificationMode === 'gain' && isFluo) {
        params.set('gain', String(appliedGain))
      }
      const res = await fetch(
        `${apiBase}/${endpoint}?${params.toString()}`,
        { headers: { accept: 'image/png' } },
      )
      if (!res.ok) {
        return {
          url: null,
          missing: res.status === 404 && (channel === 'fluo1' || channel === 'fluo2'),
        }
      }
      const blob = await res.blob()
      return { url: URL.createObjectURL(blob), missing: false }
    }

    const loadImages = async () => {
      setIsLoadingImages(true)
      setError(null)
      setImages(createEmptyImages())
      setMissingChannels(createEmptyMissingChannels())
      try {
        const results = await Promise.all(
          channels.map((channel) => fetchChannel(channel.key)),
        )
        if (!isActive) {
          results.forEach((result) => {
            if (result.url) URL.revokeObjectURL(result.url)
          })
          return
        }
        setImages({
          ph: results[0].url,
          fluo1: results[1].url,
          fluo2: results[2].url,
        })
        setMissingChannels({
          ph: results[0].missing,
          fluo1: results[1].missing,
          fluo2: results[2].missing,
        })
      } catch (err) {
        if (isActive) {
          setError(err instanceof Error ? err.message : 'Failed to load images')
          setImages(createEmptyImages())
          setMissingChannels(createEmptyMissingChannels())
        }
      } finally {
        if (isActive) setIsLoadingImages(false)
      }
    }

    void loadImages()
    return () => {
      isActive = false
    }
  }, [
    apiBase,
    dbName,
    currentCellId,
    overlayOptions,
    fluoColors,
    modificationMode,
    contourRefreshKey,
    appliedGain,
    canUseFastImages,
    fastCell,
  ])

  useEffect(() => {
    if (canUseFastLabels && fastCell) {
      setIsLoadingLabel(false)
      setManualLabelError(null)
      setManualLabel(fastCell.manualLabel)
      return
    }
    if (!dbName || !currentCellId) {
      setManualLabel(null)
      setManualLabelError(null)
      return
    }
    let isActive = true
    const loadLabel = async () => {
      setIsLoadingLabel(true)
      setManualLabelError(null)
      try {
        const res = await fetch(
          `${apiBase}/get-cell-label?dbname=${encodeURIComponent(
            dbName,
          )}&cell_id=${encodeURIComponent(currentCellId)}`,
          { headers: { accept: 'application/json' } },
        )
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const label = (await res.json()) as string
        if (isActive) {
          setManualLabel(normalizeManualLabel(label))
        }
      } catch {
        if (isActive) {
          setManualLabel(null)
        }
      } finally {
        if (isActive) setIsLoadingLabel(false)
      }
    }

    void loadLabel()
    return () => {
      isActive = false
    }
  }, [apiBase, canUseFastLabels, currentCellId, dbName, fastCell])

  const manualLabelOptions = useMemo(() => {
    const baseOptions = labelOptions.filter((option) => option !== 'All')
    const normalized = normalizeManualLabel(manualLabel)
    if (normalized && !baseOptions.includes(normalized)) {
      return [normalized, ...baseOptions]
    }
    return baseOptions
  }, [labelOptions, manualLabel])

  const updateManualLabel = useCallback(
    async (nextLabel: string) => {
      if (!dbName || !currentCellId) return
      const trimmed = nextLabel.trim()
      if (!trimmed) return
      setIsUpdatingLabel(true)
      setManualLabelError(null)
      const previousLabel = manualLabel
      setManualLabel(trimmed)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: currentCellId,
          label: trimmed,
        })
        const res = await fetch(`${apiBase}/update-cell-label?${params.toString()}`, {
          method: 'PATCH',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) {
          throw new Error(`Label update failed (${res.status})`)
        }
        if (fastModeRequested && selectedLabel === 'All') {
          setFastBundle((previous) => {
            if (!previous) return previous
            const target = previous[currentCellId]
            if (!target) return previous
            return {
              ...previous,
              [currentCellId]: {
                ...target,
                manualLabel: normalizeManualLabel(trimmed),
              },
            }
          })
        }
        await fetchLabelOptions()
      } catch (err) {
        setManualLabel(previousLabel)
        setManualLabelError(err instanceof Error ? err.message : 'Failed to update label')
      } finally {
        setIsUpdatingLabel(false)
      }
    },
    [
      apiBase,
      currentCellId,
      dbName,
      fastModeRequested,
      fetchLabelOptions,
      manualLabel,
      selectedLabel,
    ],
  )

  useEffect(() => {
    if (!dbName || !currentCellId || contourMode !== 'contour') {
      setContourData([])
      setContourError(null)
      setIsLoadingContour(false)
      return
    }
    let isActive = true
    const loadContour = async () => {
      setIsLoadingContour(true)
      setContourError(null)
      setContourData([])
      try {
        const res = await fetch(
          `${apiBase}/get-cell-contour?dbname=${encodeURIComponent(
            dbName,
          )}&cell_id=${encodeURIComponent(currentCellId)}`,
          { headers: { accept: 'application/json' } },
        )
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const data = (await res.json()) as { contour?: number[][] }
        if (isActive) {
          setContourData(Array.isArray(data.contour) ? data.contour : [])
        }
      } catch (err) {
        if (isActive) {
          setContourData([])
          setContourError(err instanceof Error ? err.message : 'Failed to load contour')
        }
      } finally {
        if (isActive) setIsLoadingContour(false)
      }
    }

    void loadContour()
    return () => {
      isActive = false
    }
  }, [apiBase, contourMode, currentCellId, dbName, contourRefreshKey, heatmapChannel])

  useEffect(() => {
    if (!dbName || !currentCellId || contourMode !== 'replot') {
      setReplotUrl(null)
      setReplotError(null)
      setIsLoadingReplot(false)
      return
    }
    let isActive = true
    const loadReplot = async () => {
      setIsLoadingReplot(true)
      setReplotError(null)
      setReplotUrl(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: currentCellId,
          image_type: replotChannel,
          degree: '4',
          dark_mode: 'true',
          mesh: String(replotMesh),
        })
        const res = await fetch(`${apiBase}/get-cell-replot?${params.toString()}`, {
          headers: { accept: 'image/png' },
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        if (isActive) {
          setReplotUrl(url)
        } else {
          URL.revokeObjectURL(url)
        }
      } catch (err) {
        if (isActive) {
          setReplotUrl(null)
          setReplotError(err instanceof Error ? err.message : 'Failed to load replot')
        }
      } finally {
        if (isActive) setIsLoadingReplot(false)
      }
    }

    void loadReplot()
    return () => {
      isActive = false
    }
  }, [apiBase, contourMode, currentCellId, dbName, contourRefreshKey, replotChannel, replotMesh])

  useEffect(() => {
    const shouldLoadOverlay =
      contourMode === 'overlay' ||
      contourMode === 'overlay-fluo' ||
      contourMode === 'overlay-raw'
    if (!dbName || !currentCellId || !shouldLoadOverlay) {
      setOverlayUrl(null)
      setOverlayError(null)
      setIsLoadingOverlay(false)
      return
    }
    let isActive = true
    const controller = new AbortController()

    const loadOverlay = async () => {
      setIsLoadingOverlay(true)
      setOverlayError(null)
      setOverlayUrl(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: currentCellId,
          draw_scale_bar: String(overlayOptions.scale),
          overlay_mode:
            contourMode === 'overlay-fluo'
              ? 'fluo'
              : contourMode === 'overlay-raw'
                ? 'raw'
                : 'ph',
        })
        params.set('fluo1_color', fluoColors.fluo1)
        params.set('fluo2_color', fluoColors.fluo2)
        const res = await fetch(`${apiBase}/get-cell-overlay?${params.toString()}`, {
          signal: controller.signal,
          headers: { accept: 'image/png' },
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        if (isActive) {
          setOverlayUrl(url)
        } else {
          URL.revokeObjectURL(url)
        }
      } catch (err) {
        if (isActive) {
          setOverlayError(err instanceof Error ? err.message : 'Failed to load overlay')
          setOverlayUrl(null)
        }
      } finally {
        if (isActive) setIsLoadingOverlay(false)
      }
    }

    void loadOverlay()
    return () => {
      isActive = false
      controller.abort()
    }
  }, [
    apiBase,
    contourMode,
    currentCellId,
    dbName,
    contourRefreshKey,
    overlayOptions.scale,
    fluoColors,
  ])

  useEffect(() => {
    if (!dbName || !currentCellId || contourMode !== 'heatmap') {
      setHeatmapUrl(null)
      setHeatmapError(null)
      setIsLoadingHeatmap(false)
      return
    }
    let isActive = true
    const loadHeatmap = async () => {
      setIsLoadingHeatmap(true)
      setHeatmapError(null)
      setHeatmapUrl(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: currentCellId,
          image_type: heatmapChannel,
          degree: '4',
        })
        const res = await fetch(`${apiBase}/get-cell-heatmap?${params.toString()}`, {
          headers: { accept: 'image/png' },
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        if (isActive) {
          setHeatmapUrl(url)
        } else {
          URL.revokeObjectURL(url)
        }
      } catch (err) {
        if (isActive) {
          setHeatmapUrl(null)
          setHeatmapError(err instanceof Error ? err.message : 'Failed to load heatmap')
        }
      } finally {
        if (isActive) setIsLoadingHeatmap(false)
      }
    }

    void loadHeatmap()
    return () => {
      isActive = false
    }
  }, [apiBase, contourMode, currentCellId, dbName, contourRefreshKey, heatmapChannel])

  useEffect(() => {
    const isMapMode = contourMode === 'map256' || contourMode === 'map-raw'
    if (!dbName || !currentCellId || !isMapMode) {
      setMap256Url(null)
      setMap256JetUrl(null)
      setMap256Error(null)
      setMap256JetError(null)
      setIsLoadingMap256(false)
      return
    }
    const mapModeParam = contourMode === 'map-raw' ? 'raw' : 'map256'
    let isActive = true
    const loadMap256 = async () => {
      setIsLoadingMap256(true)
      setMap256Error(null)
      setMap256JetError(null)
      setMap256Url(null)
      setMap256JetUrl(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: currentCellId,
          image_type: map256Channel,
          degree: '4',
          map_mode: mapModeParam,
        })
        const fetchMap = async (endpoint: string) => {
          const res = await fetch(`${apiBase}/${endpoint}?${params.toString()}`, {
            headers: { accept: 'image/png' },
          })
          if (!res.ok) {
            throw new Error(`Request failed (${res.status})`)
          }
          const blob = await res.blob()
          return URL.createObjectURL(blob)
        }
        const [rawResult, jetResult] = await Promise.allSettled([
          fetchMap('get-cell-map256'),
          fetchMap('get-cell-map256-jet'),
        ])
        if (!isActive) {
          if (rawResult.status === 'fulfilled') {
            URL.revokeObjectURL(rawResult.value)
          }
          if (jetResult.status === 'fulfilled') {
            URL.revokeObjectURL(jetResult.value)
          }
          return
        }
        if (rawResult.status === 'fulfilled') {
          setMap256Url(rawResult.value)
        } else {
          setMap256Error(
            rawResult.reason instanceof Error
              ? rawResult.reason.message
              : 'Failed to load map256',
          )
        }
        if (jetResult.status === 'fulfilled') {
          setMap256JetUrl(jetResult.value)
        } else {
          setMap256JetError(
            jetResult.reason instanceof Error
              ? jetResult.reason.message
              : 'Failed to load map256 jet',
          )
        }
      } catch (err) {
        if (isActive) {
          const message =
            err instanceof Error ? err.message : 'Failed to load map256'
          setMap256Url(null)
          setMap256JetUrl(null)
          setMap256Error(message)
          setMap256JetError(message)
        }
      } finally {
        if (isActive) setIsLoadingMap256(false)
      }
    }

    void loadMap256()
    return () => {
      isActive = false
    }
  }, [
    apiBase,
    contourMode,
    currentCellId,
    dbName,
    contourRefreshKey,
    map256Channel,
  ])

  useEffect(() => {
    if (!dbName || !currentCellId || contourMode !== 'distribution') {
      setDistributionUrl(null)
      setDistributionError(null)
      setIsLoadingDistribution(false)
      return
    }
    let isActive = true
    const loadDistribution = async () => {
      setIsLoadingDistribution(true)
      setDistributionError(null)
      setDistributionUrl(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: currentCellId,
          image_type: distributionChannel,
        })
        const res = await fetch(`${apiBase}/get-cell-distribution?${params.toString()}`, {
          headers: { accept: 'image/png' },
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        if (isActive) {
          setDistributionUrl(url)
        } else {
          URL.revokeObjectURL(url)
        }
      } catch (err) {
        if (isActive) {
          setDistributionUrl(null)
          setDistributionError(
            err instanceof Error ? err.message : 'Failed to load distribution',
          )
        }
      } finally {
        if (isActive) setIsLoadingDistribution(false)
      }
    }

    void loadDistribution()
    return () => {
      isActive = false
    }
  }, [
    apiBase,
    contourMode,
    currentCellId,
    dbName,
    contourRefreshKey,
    distributionChannel,
  ])

  const handleApplyModification = async () => {
    if (!dbName || !currentCellId || isApplyingModification || isApplyingBulkModification) {
      return
    }
    if (modificationMode === 'gain' && !isGainValid) {
      setModificationError('Gain must be greater than 0.')
      return
    }
    setIsApplyingModification(true)
    setModificationError(null)
    try {
      if (modificationMode === 'elastic') {
        const params = new URLSearchParams({
          dbname: dbName,
          cell_id: currentCellId,
          delta: String(elasticDelta),
        })
        const res = await fetch(`${apiBase}/elastic-contour?${params.toString()}`, {
          method: 'PATCH',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        setContourRefreshKey((prev) => prev + 1)
      } else if (modificationMode === 'gain') {
        setAppliedGain(parsedGain)
        setContourRefreshKey((prev) => prev + 1)
      }
    } catch (err) {
      setModificationError(
        err instanceof Error ? err.message : 'Failed to apply modification',
      )
    } finally {
      setIsApplyingModification(false)
    }
  }

  const handleApplyBulkModification = async () => {
    if (!dbName || isApplyingModification || isApplyingBulkModification) return
    if (cellCount === 0) return
    if (modificationMode !== 'elastic') return
    setIsApplyingBulkModification(true)
    setModificationError(null)
    try {
      const params = new URLSearchParams({
        dbname: dbName,
        delta: String(elasticDelta),
      })
      if (selectedLabel !== 'All') {
        params.set('label', selectedLabel)
      }
      const res = await fetch(`${apiBase}/elastic-contour-bulk?${params.toString()}`, {
        method: 'PATCH',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const payload = (await res.json().catch(() => null)) as
        | { total?: number; updated?: number; failed?: number }
        | null
      if (payload?.failed) {
        const total = payload.total ?? cellCount
        const updated = payload.updated ?? Math.max(total - payload.failed, 0)
        setModificationError(
          `Applied to ${updated} / ${total} cells. ${payload.failed} failed.`,
        )
      }
      setContourRefreshKey((prev) => prev + 1)
    } catch (err) {
      setModificationError(
        err instanceof Error ? err.message : 'Failed to apply modification',
      )
    } finally {
      setIsApplyingBulkModification(false)
    }
  }

  useEffect(() => {
    return () => {
      if (replotUrl) {
        URL.revokeObjectURL(replotUrl)
      }
    }
  }, [replotUrl])

  useEffect(() => {
    return () => {
      if (overlayUrl) {
        URL.revokeObjectURL(overlayUrl)
      }
    }
  }, [overlayUrl])

  useEffect(() => {
    return () => {
      if (heatmapUrl) {
        URL.revokeObjectURL(heatmapUrl)
      }
    }
  }, [heatmapUrl])

  useEffect(() => {
    return () => {
      if (map256Url) {
        URL.revokeObjectURL(map256Url)
      }
    }
  }, [map256Url])

  useEffect(() => {
    return () => {
      if (map256JetUrl) {
        URL.revokeObjectURL(map256JetUrl)
      }
    }
  }, [map256JetUrl])

  useEffect(() => {
    return () => {
      if (distributionUrl) {
        URL.revokeObjectURL(distributionUrl)
      }
    }
  }, [distributionUrl])

  useEffect(() => {
    if (!activeImages.ph) {
      setImageDimensions(null)
      return
    }
    let isActive = true
    const img = new Image()
    img.onload = () => {
      if (isActive) {
        const dims = {
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        }
        setImageDimensions(dims)
      }
    }
    img.onerror = () => {
      if (isActive) {
        setImageDimensions(null)
      }
    }
    img.src = activeImages.ph
    return () => {
      isActive = false
    }
  }, [activeImages.ph])

  useEffect(() => {
    return () => {
      Object.values(images).forEach((url) => {
        if (url) URL.revokeObjectURL(url)
      })
    }
  }, [images])

  useEffect(() => {
    return () => {
      revokeFastBundleUrls(fastBundle)
    }
  }, [fastBundle, revokeFastBundleUrls])

  const handlePrevious = () => {
    setCurrentIndex((prev) => Math.max(prev - 1, 0))
  }

  const handleNext = () => {
    setCurrentIndex((prev) => Math.min(prev + 1, Math.max(cellCount - 1, 0)))
  }

  const handleDownloadImage = useCallback(
    (channel: ChannelKey) => {
      const url = activeImages[channel]
      if (!url) return
      const safeDb = toSafeFilenamePart(dbName, 'db')
      const safeCell = toSafeFilenamePart(currentCellId, 'cell')
      const filename = `cell-${safeDb}-${safeCell}-${channel}.png`
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    },
    [activeImages, dbName, currentCellId],
  )

  const isApplyingAnyModification = isApplyingModification || isApplyingBulkModification
  const parsedGain = Number(gainInput)
  const isGainValid =
    gainInput.trim() !== '' && Number.isFinite(parsedGain) && parsedGain > 0
  const isNavigatorDisabled =
    cellCount === 0 ||
    isLoadingIds ||
    (fastModeRequested && selectedLabel === 'All' && isLoadingFastBundle && !fastBundle)
  const isOverlayMode =
    contourMode === 'overlay' ||
    contourMode === 'overlay-fluo' ||
    contourMode === 'overlay-raw'
  const contourPanelError =
    contourMode === 'replot'
      ? replotError
      : isOverlayMode
        ? overlayError
        : contourMode === 'heatmap'
          ? heatmapError
          : contourMode === 'map256' || contourMode === 'map-raw'
            ? map256Error || map256JetError
          : contourMode === 'distribution'
            ? distributionError
          : contourError
  const isContourPending =
    contourMode === 'contour' &&
    (isLoadingContour || (contourData.length > 0 && !imageDimensions))
  const isOverlayPending = isOverlayMode && isLoadingOverlay
  const isHeatmapPending = contourMode === 'heatmap' && isLoadingHeatmap
  const isMap256Pending =
    (contourMode === 'map256' || contourMode === 'map-raw') && isLoadingMap256
  const isDistributionPending =
    contourMode === 'distribution' && isLoadingDistribution

  const contourView = useMemo(() => {
    const points = contourData
      .filter((pt) => Array.isArray(pt) && pt.length >= 2)
      .map(([x, y]) => [Number(x), Number(y)] as const)
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    if (points.length === 0) return null
    const pathSegments = points.map(([x, y]) => `${x} ${y}`).join(' L ')
    const path = `M ${pathSegments}${points.length > 1 ? ' Z' : ''}`

    if (!imageDimensions) {
      return null
    }
    return {
      viewBox: `0 0 ${imageDimensions.width} ${imageDimensions.height}`,
      bounds: {
        minX: 0,
        minY: 0,
        width: imageDimensions.width,
        height: imageDimensions.height,
      },
      path,
    }
  }, [contourData, imageDimensions])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isHelpOpen) return

      const target = event.target as HTMLElement | null
      if (target) {
        const tagName = target.tagName
        if (
          tagName === 'INPUT' ||
          tagName === 'TEXTAREA' ||
          tagName === 'SELECT' ||
          target.isContentEditable
        ) {
          return
        }
      }
      if (isNavigatorDisabled) return

      if (event.key === 'Enter') {
        event.preventDefault()
        setCurrentIndex((prev) => Math.min(prev + 1, Math.max(cellCount - 1, 0)))
      } else if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault()
        setCurrentIndex((prev) => Math.max(prev - 1, 0))
      } else if (event.key === 'n' || event.key === 'N') {
        event.preventDefault()
        void updateManualLabel('N/A')
      } else if (event.key === '1') {
        event.preventDefault()
        void updateManualLabel('1')
      } else if (event.key === '2') {
        event.preventDefault()
        void updateManualLabel('2')
      } else if (event.key === '3') {
        event.preventDefault()
        void updateManualLabel('3')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cellCount, isHelpOpen, isNavigatorDisabled, updateManualLabel])

  return (
    <Box
      minH="100dvh"
      h={{ base: 'auto', lg: '100dvh' }}
      bg="sand.50"
      color="ink.900"
      display="flex"
      flexDirection="column"
      overflow={{ base: 'visible', lg: 'hidden' }}
    >
      <PageHeader
        actions={
          <>
            <ReloadButton compact />
            <ThemeToggleButton compact />
            <CellsHelpDrawer open={isHelpOpen} onOpenChange={setIsHelpOpen} />
          </>
        }
      />

      <PageContainer
        py={{ base: 4, md: 3, lg: 2 }}
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
                  Home
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbLink as={RouterLink} to={databasesPagePath}>
                  Databases
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbCurrentLink color="ink.900">Cells</BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>
        <Stack spacing={{ base: 4, lg: 3 }} flex="1" minH="0" overflow="hidden">
          <Box
            borderRadius="xl"
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            p={{ base: 3, lg: 2 }}
            flexShrink={0}
          >
            <Stack spacing="2">
              <HStack spacing="2" justify="space-between" flexWrap="wrap">
                <Text fontSize="xs" color="ink.700">
                  Cell Control Panel
                </Text>
                <HStack spacing="2" align="center">
                  {fastModeRequested && (
                    <Badge
                      bg={canUseFastImages ? 'teal.500' : 'sand.200'}
                      color={canUseFastImages ? 'white' : 'ink.700'}
                      borderRadius="full"
                      px="2"
                      py="1"
                      fontSize="11px"
                      textTransform="uppercase"
                    >
                      Fast mode
                    </Badge>
                  )}
                  <Text fontSize="xs" color="ink.700">
                    Database: {dbName || 'Not selected'}
                  </Text>
                </HStack>
              </HStack>
              <Grid
                templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }}
                gap="3"
              >
                <Box>
                  <Stack spacing="1">
                    <HStack spacing="2" align="flex-start" flexWrap="wrap">
                      <Box>
                        <Text fontSize="xs" color="ink.700" mb="1">
                          Label Filter
                        </Text>
                        <NativeSelect.Root size={{ base: 'md', lg: 'sm' }}>
                          <NativeSelect.Field
                            value={selectedLabel}
                            onChange={(event) => setSelectedLabel(event.target.value)}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            w="7rem"
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
                      </Box>
                      <Box>
                        <Text fontSize="xs" color="ink.700" mb="1">
                          Manual label
                        </Text>
                        <NativeSelect.Root size={{ base: 'md', lg: 'sm' }}>
                          <NativeSelect.Field
                            value={manualLabel ?? ''}
                            onChange={(event) => updateManualLabel(event.target.value)}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            w="8rem"
                            color="ink.900"
                            disabled={
                              !dbName || !currentCellId || isLoadingLabel || isUpdatingLabel
                            }
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            <option value="" disabled>
                              Not set
                            </option>
                            {manualLabelOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                      </Box>
                    </HStack>
                    {manualLabelError && (
                      <Text fontSize="xs" color="violet.300">
                        {manualLabelError}
                      </Text>
                    )}
                  </Stack>
                </Box>
                <Box>
                  <Text fontSize="xs" color="ink.700" mb="1">
                    Overlays
                  </Text>
                  <HStack spacing="4" align="center" minH={{ base: '2.25rem', lg: '2rem' }}>
                    <Checkbox.Root
                      checked={overlayOptions.contour}
                      onCheckedChange={(details) =>
                        setOverlayOptions((prev) => ({
                          ...prev,
                          contour: details.checked,
                        }))
                      }
                      colorPalette="tide"
                      display="flex"
                      alignItems="center"
                      gap="2"
                      minW="0"
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control
                        borderColor="tide.400"
                        _checked={{ bg: 'tide.500', borderColor: 'tide.500', color: 'white' }}
                        flexShrink={0}
                      />
                      <Checkbox.Label fontSize="sm" color="ink.700" minW="0" overflowWrap="anywhere">
                        Contour
                      </Checkbox.Label>
                    </Checkbox.Root>
                    <Checkbox.Root
                      checked={overlayOptions.scale}
                      onCheckedChange={(details) =>
                        setOverlayOptions((prev) => ({
                          ...prev,
                          scale: details.checked,
                        }))
                      }
                      colorPalette="tide"
                      display="flex"
                      alignItems="center"
                      gap="2"
                      minW="0"
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control
                        borderColor="tide.400"
                        _checked={{ bg: 'tide.500', borderColor: 'tide.500', color: 'white' }}
                        flexShrink={0}
                      />
                      <Checkbox.Label fontSize="sm" color="ink.700" minW="0" overflowWrap="anywhere">
                        Scale
                      </Checkbox.Label>
                    </Checkbox.Root>
                  </HStack>
                </Box>
                <Box>
                  <Text fontSize="xs" color="ink.700" mb="1">
                    Navigator
                  </Text>
                  <Stack spacing="2">
                    <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap="2">
                      <Box>
                        <Text fontSize="xs" color="ink.700">
                          Current cell
                        </Text>
                        <Text fontSize="sm" fontWeight="600">
                          {currentCellId || '-'}
                        </Text>
                      </Box>
                      <Box>
                        <Text fontSize="xs" color="ink.700">
                          Manual label
                        </Text>
                        <Text fontSize="sm" fontWeight="600">
                          {isLoadingLabel ? 'Loading...' : manualLabel ?? '-'}
                        </Text>
                      </Box>
                      <Box>
                        <Text fontSize="xs" color="ink.700">
                          Index
                        </Text>
                        <Text fontSize="sm" fontWeight="600">
                          {cellCount ? currentIndex + 1 : 0} / {cellCount}
                        </Text>
                      </Box>
                    </Grid>
                  </Stack>
                </Box>
              </Grid>
            </Stack>
          </Box>

          {error && (
            <Box px="4" py="3" bg="sand.100" borderRadius="md" border="1px solid" borderColor="sand.200">
              <Text fontSize="sm" color="violet.300">
                {error}
              </Text>
            </Box>
          )}

          {isLoadingIds && (
            <Text fontSize="sm" color="ink.700">
              Loading cell IDs...
            </Text>
          )}

          {fastModeRequested && selectedLabel === 'All' && isLoadingFastBundle && (
            <HStack
              spacing="2"
              align="center"
              px="4"
              py="3"
              bg="sand.100"
              borderRadius="md"
              border="1px solid"
              borderColor="sand.200"
            >
              <Spinner size="sm" color="tide.300" />
              <Text fontSize="sm" color="ink.700">
                Fast preloading cells...
              </Text>
            </HStack>
          )}

          {fastModeRequested && selectedLabel === 'All' && fastBundleError && (
            <Text fontSize="sm" color="violet.300">
              Fast preload failed; using normal loading. {fastBundleError}
            </Text>
          )}

          {!isLoadingIds && !error && cellCount === 0 && dbName && (
            <Text fontSize="sm" color="ink.700">
              No cells found in this database.
            </Text>
          )}

          <Grid
            templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}
            gap={{ base: 4, lg: 3 }}
            alignItems="stretch"
            flex="1"
            minH="0"
            overflow="hidden"
          >
            <Box
              overflowX={{ base: 'auto', lg: 'visible' }}
              overflowY="hidden"
              pb={{ base: 1, lg: 0 }}
              h="100%"
              display="flex"
              flexDirection="column"
              gap="2"
              minH="0"
            >
              <Box
                borderRadius="xl"
                bg="sand.100"
                border="1px dashed"
                borderColor="sand.200"
                p="2"
                flex="0 0 auto"
                order={0}
              >
                <Stack spacing="2">
                  <Text fontSize="xs" color="ink.700">
                    Modification
                  </Text>
                  <HStack spacing="2" align="flex-end" flexWrap="wrap">
                    <Box minW="10rem">
                      <Stack spacing="1">
                        <Text fontSize="xs" color="ink.700">
                          Mode
                        </Text>
                        <NativeSelect.Root size={{ base: 'md', lg: 'sm' }}>
                          <NativeSelect.Field
                            value={modificationMode}
                            onChange={(event) =>
                              setModificationMode(
                                event.target.value as 'elastic' | 'optical-boost' | 'gain',
                              )
                            }
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            <option value="elastic">Elastic contour</option>
                            <option value="gain">Gain</option>
                            <option value="optical-boost">Optical boost</option>
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                      </Stack>
                    </Box>
                    {modificationMode === 'elastic' && (
                      <>
                        <Box minW="9rem">
                          <Stack spacing="1">
                            <Text fontSize="xs" color="ink.700">
                              Elastic Δ
                            </Text>
                            <Input
                              size={{ base: 'md', lg: 'sm' }}
                              type="number"
                              value={elasticDelta}
                              onChange={(event) => {
                                const next = Number(event.target.value)
                                setElasticDelta(Number.isNaN(next) ? 0 : next)
                              }}
                              min={-3}
                              max={3}
                              step={1}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            />
                          </Stack>
                        </Box>
                        <Box minW="6rem" display="flex" alignItems="center">
                          <Button
                            size={{ base: 'md', lg: 'sm' }}
                            onClick={handleApplyModification}
                            disabled={!dbName || !currentCellId || isApplyingAnyModification}
                            variant="outline"
                          >
                            {isApplyingModification ? 'Applying...' : 'Apply'}
                          </Button>
                        </Box>
                        <Box minW="8rem" display="flex" alignItems="center">
                          <Button
                            size={{ base: 'md', lg: 'sm' }}
                            variant="outline"
                            onClick={handleApplyBulkModification}
                            disabled={
                              !dbName ||
                              cellCount === 0 ||
                              isLoadingIds ||
                              isApplyingAnyModification
                            }
                          >
                            {isApplyingBulkModification ? 'Applying all...' : 'Apply bulk'}
                          </Button>
                        </Box>
                      </>
                    )}
                    {modificationMode === 'gain' && (
                      <>
                        <Box minW="9rem">
                          <Stack spacing="1">
                            <Text fontSize="xs" color="ink.700">
                              Gain (x)
                            </Text>
                            <Input
                              size={{ base: 'md', lg: 'sm' }}
                              type="number"
                              min={0.01}
                              step={0.1}
                              value={gainInput}
                              onChange={(event) => {
                                const nextValue = event.target.value
                                setGainInput(nextValue)
                                if (nextValue.trim() === '') return
                                const next = Number(nextValue)
                                if (!Number.isFinite(next) || next <= 0) return
                                setGainValue(next)
                              }}
                              onBlur={() => {
                                const trimmed = gainInput.trim()
                                if (trimmed === '') {
                                  setGainInput(String(gainValue))
                                  return
                                }
                                const next = Number(trimmed)
                                if (!Number.isFinite(next) || next <= 0) {
                                  setGainInput(String(gainValue))
                                  return
                                }
                                const normalized = Math.max(0.01, next)
                                setGainValue(normalized)
                                setGainInput(String(normalized))
                              }}
                              bg="sand.50"
                              border="1px solid"
                              borderColor="sand.200"
                              color="ink.900"
                              _focusVisible={{
                                borderColor: 'tide.400',
                                boxShadow: '0 0 0 1px var(--app-accent-ring)',
                              }}
                            />
                          </Stack>
                        </Box>
                        <Box minW="6rem" display="flex" alignItems="center">
                          <Button
                            size={{ base: 'md', lg: 'sm' }}
                            onClick={handleApplyModification}
                            disabled={
                              !dbName ||
                              !currentCellId ||
                              isApplyingAnyModification ||
                              !isGainValid
                            }
                            variant="outline"
                          >
                            {isApplyingModification ? 'Applying...' : 'Apply'}
                          </Button>
                        </Box>
                      </>
                    )}
                  </HStack>
                  {modificationError && (
                    <Text fontSize="xs" color="violet.300">
                      {modificationError}
                    </Text>
                  )}
                </Stack>
              </Box>
              <Grid
                templateColumns={{
                  base: 'repeat(3, 200px)',
                  md: 'repeat(3, minmax(0, 1fr))',
                }}
                gap="2"
                minW={{ base: 'max-content', md: '0' }}
                order={1}
                flex="1"
                minH="0"
                overflow="hidden"
              >
                {channels.map((channel) => (
                  <Box
                    key={channel.key}
                    borderRadius="xl"
                    bg="sand.100"
                    border="1px solid"
                    borderColor="sand.200"
                    p="2"
                    display="flex"
                    flexDirection="column"
                    minH="0"
                  >
                    <HStack spacing="1.5" align="center" mb="2" pr="1">
                      <Text
                        fontSize="0.7rem"
                        letterSpacing="0.1em"
                        color="ink.700"
                      >
                        {channel.label}
                      </Text>
                      <IconButton
                        aria-label={`Download ${channel.label} image`}
                        size="xs"
                        variant="ghost"
                        color="tide.300"
                        _hover={{ bg: 'sand.200', color: 'tide.300' }}
                        _active={{ bg: 'sand.300' }}
                        disabled={isLoadingImages || !activeImages[channel.key]}
                        onClick={() => handleDownloadImage(channel.key)}
                      >
                        <Download size={14} />
                      </IconButton>
                      {channel.key !== 'ph' && (
                        <NativeSelect.Root size="xs" w={{ base: '4.25rem', lg: '4.75rem' }} flexShrink={0}>
                          <NativeSelect.Field
                            value={fluoColors[channel.key]}
                            onChange={(event) => {
                              const next = event.target.value as FluoColor
                              setFluoColors((prev) => ({ ...prev, [channel.key]: next }))
                            }}
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="11px"
                            color="ink.900"
                            pl="1.5"
                            pr="1.75rem"
                            w={{ base: '4.25rem', lg: '4.75rem' }}
                            disabled={!dbName || !currentCellId}
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          >
                            {fluoColorOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator color="ink.700" />
                        </NativeSelect.Root>
                      )}
                    </HStack>
                    <AspectRatio
                      ratio={1}
                      bg="sand.200"
                      borderRadius="lg"
                      overflow="hidden"
                      w="100%"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      minH="0"
                      maxH="100%"
                    >
                      {isLoadingImages ? (
                        <Box display="flex" alignItems="center" justifyContent="center">
                          <Spinner color="ink.700" />
                        </Box>
                      ) : activeImages[channel.key] ? (
                        <Box
                          as="img"
                          src={activeImages[channel.key] ?? undefined}
                          alt={`${currentCellId} ${channel.label}`}
                          width="100%"
                          height="100%"
                          objectFit="cover"
                        />
                      ) : (
                        <Box display="flex" alignItems="center" justifyContent="center">
                          <Text fontSize="sm" color="ink.700">
                            {activeMissingChannels[channel.key]
                              ? `${channel.key} does not exist.`
                              : 'Image not available.'}
                          </Text>
                        </Box>
                      )}
                    </AspectRatio>
                  </Box>
                ))}
              </Grid>
              <HStack
                spacing="3"
                align="center"
                order={2}
                flexWrap={{ base: 'wrap', lg: 'nowrap' }}
                flexShrink={0}
              >
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePrevious}
                  disabled={isNavigatorDisabled || currentIndex === 0}
                  gap="1"
                >
                  <ArrowLeft size={14} />
                  Previous
                </Button>
                <Box flex="1" minW="10rem">
                  <Slider.Root
                    value={[currentIndex]}
                    min={0}
                    max={Math.max(cellCount - 1, 0)}
                    step={1}
                    onValueChange={(details) => {
                      const next = details.value[0]
                      setCurrentIndex(typeof next === 'number' ? next : 0)
                    }}
                  >
                    <Slider.Control>
                      <Slider.Track bg="sand.200">
                        <Slider.Range bg="tide.400" />
                      </Slider.Track>
                      <Slider.Thumb index={0} />
                    </Slider.Control>
                  </Slider.Root>
                </Box>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleNext}
                  disabled={isNavigatorDisabled || currentIndex >= cellCount - 1}
                  gap="1"
                >
                  Next
                  <ArrowRight size={14} />
                </Button>
              </HStack>
            </Box>

            <Box
              borderRadius="xl"
              bg="sand.100"
              border="1px solid"
              borderColor="sand.200"
              p="2"
              h="100%"
              display="flex"
              flexDirection="column"
              minH="0"
            >
              <Stack spacing="2" flex="1" minH="0">
                <HStack justify="space-between" align="center" spacing="3" flexWrap="nowrap">
                  <Text fontSize="xs" color="ink.700">
                    Function Panel
                  </Text>
                  <HStack spacing="2" flexWrap="nowrap">
                    <Text fontSize="xs" color="ink.700" whiteSpace="nowrap">
                      Draw mode
                    </Text>
                    <NativeSelect.Root size="sm">
                      <NativeSelect.Field
                        value={contourMode}
                        onChange={(event) =>
                          setContourMode(
                            event.target.value as
                              | 'contour'
                              | 'replot'
                              | 'overlay'
                              | 'overlay-fluo'
                              | 'overlay-raw'
                              | 'heatmap'
                              | 'map256'
                              | 'map-raw'
                              | 'distribution',
                          )
                        }
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        <option value="contour">Contour</option>
                        <option value="replot">Replot</option>
                        <option value="overlay">Overlay</option>
                        <option value="overlay-raw">Overlay Raw</option>
                        <option value="overlay-fluo">Overlay Fluo</option>
                        <option value="heatmap">Heatmap</option>
                        <option value="map256">Map 256</option>
                        <option value="map-raw">Map Raw</option>
                        <option value="distribution">Distribution</option>
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </HStack>
                </HStack>
                {contourMode === 'heatmap' && (
                  <HStack spacing="2" align="center" flexWrap="nowrap">
                    <Text fontSize="xs" color="ink.700" whiteSpace="nowrap">
                      Channel
                    </Text>
                    <NativeSelect.Root size="sm" w="6rem" flexShrink={0}>
                      <NativeSelect.Field
                        value={heatmapChannel}
                        onChange={(event) =>
                          setHeatmapChannel(event.target.value as 'fluo1' | 'fluo2')
                        }
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        <option value="fluo1">Fluo1</option>
                        <option value="fluo2">Fluo2</option>
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </HStack>
                )}
                {(contourMode === 'map256' || contourMode === 'map-raw') && (
                  <HStack spacing="2" align="center" flexWrap="nowrap">
                    <Text fontSize="xs" color="ink.700" whiteSpace="nowrap">
                      Channel
                    </Text>
                    <NativeSelect.Root size="sm" w="6rem" flexShrink={0}>
                      <NativeSelect.Field
                        value={map256Channel}
                        onChange={(event) =>
                          setMap256Channel(
                            event.target.value as 'fluo1' | 'fluo2' | 'overlay',
                          )
                        }
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        <option value="fluo1">Fluo1</option>
                        <option value="fluo2">Fluo2</option>
                        <option value="overlay">Overlay</option>
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </HStack>
                )}
                {contourMode === 'distribution' && (
                  <HStack spacing="2" align="center" flexWrap="nowrap">
                    <Text fontSize="xs" color="ink.700" whiteSpace="nowrap">
                      Channel
                    </Text>
                    <NativeSelect.Root size="sm" w="6rem" flexShrink={0}>
                      <NativeSelect.Field
                        value={distributionChannel}
                        onChange={(event) =>
                          setDistributionChannel(event.target.value as ChannelKey)
                        }
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
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
                  </HStack>
                )}
                {contourMode === 'replot' && (
                  <HStack spacing="2" align="center" flexWrap="nowrap">
                    <Text fontSize="xs" color="ink.700" whiteSpace="nowrap">
                      Channel
                    </Text>
                    <NativeSelect.Root size="sm" w="6rem" flexShrink={0}>
                      <NativeSelect.Field
                        value={replotChannel}
                        onChange={(event) =>
                          setReplotChannel(event.target.value as ReplotChannel)
                        }
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        {replotChannelOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                    <Switch.Root
                      size="sm"
                      checked={replotMesh}
                      onCheckedChange={(details) => setReplotMesh(details.checked)}
                      ml="auto"
                      flexShrink={0}
                    >
                      <Switch.HiddenInput />
                      <Switch.Label fontSize="xs" color="ink.700">Mesh</Switch.Label>
                      <Switch.Control bg="sand.300" _checked={{ bg: 'tide.500' }}>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Text as="span" fontSize="xs" color="ink.700" minW="1.5rem" aria-hidden="true">
                        {replotMesh ? 'ON' : 'OFF'}
                      </Text>
                    </Switch.Root>
                  </HStack>
                )}
                <Box
                  bg="sand.200"
                  borderRadius="lg"
                  overflow="hidden"
                  flex="1"
                  minH={{ base: '11rem', lg: 'clamp(9rem, 30vh, 22rem)' }}
                >
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    width="100%"
                    height="100%"
                  >
                    {contourMode === 'replot' ? (
                      isLoadingReplot ? (
                        <Spinner color="ink.700" />
                      ) : replotUrl ? (
                        <Box
                          as="img"
                          src={replotUrl ?? undefined}
                          alt={`${currentCellId} replot`}
                          width="100%"
                          height="100%"
                          objectFit="contain"
                        />
                      ) : (
                        <Text fontSize="sm" color="ink.700">
                          Replot not available.
                        </Text>
                      )
                    ) : isOverlayMode ? (
                      isOverlayPending ? (
                        <Spinner color="ink.700" />
                      ) : overlayUrl ? (
                        <Box
                          as="img"
                          src={overlayUrl ?? undefined}
                          alt={`${currentCellId} overlay`}
                          width="100%"
                          height="100%"
                          objectFit="contain"
                        />
                      ) : (
                        <Text fontSize="sm" color="ink.700">
                          Overlay not available.
                        </Text>
                      )
                    ) : contourMode === 'heatmap' ? (
                      isHeatmapPending ? (
                        <Spinner color="ink.700" />
                      ) : heatmapUrl ? (
                        <Box
                          as="img"
                          src={heatmapUrl ?? undefined}
                          alt={`${currentCellId} heatmap`}
                          width="100%"
                          height="100%"
                          objectFit="contain"
                        />
                      ) : (
                        <Text fontSize="sm" color="ink.700">
                          Heatmap not available.
                        </Text>
                      )
                    ) : contourMode === 'map256' || contourMode === 'map-raw' ? (
                      <Box
                        width="100%"
                        height="100%"
                        p="2"
                        display="grid"
                        gridTemplateColumns="minmax(0, 1fr)"
                        gridTemplateRows="repeat(2, minmax(0, 1fr))"
                        gap="2"
                      >
                        <Box
                          display="flex"
                          flexDirection="column"
                          alignItems="center"
                          justifyContent="center"
                          minW="0"
                        >
                          <Text fontSize="xs" color="ink.700">
                            {contourMode === 'map-raw' ? 'Map Raw' : 'Map 256'}
                          </Text>
                          <Box
                            flex="1"
                            width="100%"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                          >
                            {map256Url ? (
                              <Box
                                as="img"
                                src={map256Url ?? undefined}
                                alt={`${currentCellId} ${contourMode === 'map-raw' ? 'mapraw' : 'map256'}`}
                                width="100%"
                                height="100%"
                                objectFit="contain"
                              />
                            ) : isMap256Pending ? (
                              <Spinner color="ink.700" />
                            ) : (
                              <Text fontSize="xs" color="ink.700">
                                {contourMode === 'map-raw'
                                  ? 'Map Raw not available.'
                                  : 'Map 256 not available.'}
                              </Text>
                            )}
                          </Box>
                        </Box>
                        <Box
                          display="flex"
                          flexDirection="column"
                          alignItems="center"
                          justifyContent="center"
                          minW="0"
                        >
                          <Text fontSize="xs" color="ink.700">
                            Jet
                          </Text>
                          <Box
                            flex="1"
                            width="100%"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                          >
                            {map256JetUrl ? (
                              <Box
                                as="img"
                                src={map256JetUrl ?? undefined}
                                alt={`${currentCellId} ${contourMode === 'map-raw' ? 'mapraw jet' : 'map256 jet'}`}
                                width="100%"
                                height="100%"
                                objectFit="contain"
                              />
                            ) : isMap256Pending ? (
                              <Spinner color="ink.700" />
                            ) : (
                              <Text fontSize="xs" color="ink.700">
                                Jet not available.
                              </Text>
                            )}
                          </Box>
                        </Box>
                      </Box>
                    ) : contourMode === 'distribution' ? (
                      isDistributionPending ? (
                        <Spinner color="ink.700" />
                      ) : distributionUrl ? (
                        <Box
                          as="img"
                          src={distributionUrl ?? undefined}
                          alt={`${currentCellId} distribution`}
                          width="100%"
                          height="100%"
                          objectFit="contain"
                        />
                      ) : (
                        <Text fontSize="sm" color="ink.700">
                          Distribution not available.
                        </Text>
                      )
                    ) : isContourPending ? (
                      <Text fontSize="sm" color="ink.700">
                        Loading contour...
                      </Text>
                    ) : contourView ? (
                      <Box
                        as="svg"
                        key={`${currentCellId}-${contourMode}`}
                        width="100%"
                        height="100%"
                        viewBox={contourView.viewBox}
                        preserveAspectRatio="none"
                        role="img"
                        aria-label="Cell contour"
                      >
                        <path
                          d={contourView.path}
                          fill="none"
                          stroke="lime"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      </Box>
                    ) : (
                      <Text fontSize="sm" color="ink.700">
                        No contour data.
                      </Text>
                    )}
                  </Box>
                </Box>
                {contourPanelError && (
                  <Text fontSize="sm" color="violet.300">
                    {contourPanelError}
                  </Text>
                )}
              </Stack>
            </Box>
          </Grid>
        </Stack>
      </PageContainer>
    </Box>
  )
}
