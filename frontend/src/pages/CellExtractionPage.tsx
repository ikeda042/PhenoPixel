import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import {
  AspectRatio,
  Box,
  BreadcrumbCurrentLink,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbRoot,
  BreadcrumbSeparator,
  Checkbox,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  Input,
  NativeSelect,
  Stack,
  Text,
  Separator,
  Slider,
} from '@chakra-ui/react'
import { strFromU8, unzipSync } from 'fflate'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type ExtractCellsResponse = {
  num_tiff: number
  ulid: string
  databases: { frame_start: number; frame_end: number; db_name: string }[]
  nd2_stem: string
  objective_magnification?: string
  pixel_size_um?: number
}

type ExtractCellsStartResponse = {
  job_id: string
  status: 'running' | 'queued'
}

type ExtractCellsJobStatusResponse = {
  job_id: string
  status: 'running' | 'completed' | 'failed'
  result?: ExtractCellsResponse
  error?: string
}

type Nd2FileMetadataResponse = {
  reader?: {
    axes?: string | null
    sizes?: Record<string, number | string | null>
  }
  metadata?: {
    channels?: unknown
  }
}

type OverlayFrame = {
  cellId: string
  url: string
}

type OverlayManifestEntry = {
  cell_id?: string
  file?: string
}

const DEFAULT_PARAM1 = 130
const DEFAULT_IMAGE_SIZE = 200
const OVERLAY_FRAME_INTERVAL_MS = 15
const OVERLAY_PREVIEW_SIZE = 'min(72vw, 60vh)'
const OVERLAY_PREVIEW_SCALE = 1
const OVERLAY_PREVIEW_FORMAT = 'jpeg'
const OVERLAY_PREVIEW_QUALITY = 60

const normalizeIntInput = (value: string) => {
  const digitsOnly = value.replace(/[^\d]/g, '')
  if (!digitsOnly) return ''
  const trimmed = digitsOnly.replace(/^0+/, '')
  return trimmed === '' ? '0' : trimmed
}

const coerceInt = (value: string, fallback: number, min: number) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(parsed, min)
}

const layerOptions = [
  { value: 'single', label: 'Single Layer' },
  { value: 'dual', label: 'Dual Layer' },
  { value: 'dual(reversed)', label: 'Dual Layer (Reversed)' },
  { value: 'triple', label: 'Triple Layer' },
  { value: 'quad', label: 'Quad Layer' },
]

const defaultLayerMode = layerOptions[1].value

const objectiveOptions = [
  { value: '100x', label: '100x (0.065 um/px)' },
  { value: '60x', label: '60x (0.108 um/px)' },
]

const defaultObjectiveMagnification = objectiveOptions[0].value

const parseChannelCount = (value: unknown): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

const inferLayerModeFromMetadata = (metadata: Nd2FileMetadataResponse | null) => {
  if (!metadata) return null
  const sizes = metadata.reader?.sizes

  let channelCount = parseChannelCount(sizes?.c) ?? parseChannelCount(sizes?.C)

  if (channelCount === null) {
    const channels = metadata.metadata?.channels
    if (Array.isArray(channels) && channels.length > 0) {
      channelCount = channels.length
    }
  }

  if (channelCount === null && sizes && Object.keys(sizes).length > 0) {
    const axes = typeof metadata.reader?.axes === 'string' ? metadata.reader.axes : ''
    const hasChannelAxis = axes.toLowerCase().includes('c')
    if (!hasChannelAxis && !('c' in sizes) && !('C' in sizes)) {
      channelCount = 1
    }
  }

  if (channelCount === null) return null
  if (channelCount <= 1) return 'single'
  if (channelCount === 2) return 'dual'
  if (channelCount === 3) return 'triple'
  return 'quad'
}

const parseOverlayManifestEntries = (payload: unknown): OverlayManifestEntry[] => {
  if (!payload || typeof payload !== 'object') return []
  const cells = (payload as { cells?: unknown }).cells
  if (!Array.isArray(cells)) return []
  return cells.filter((entry) => entry && typeof entry === 'object') as OverlayManifestEntry[]
}

export default function CellExtractionPage() {
  const [searchParams] = useSearchParams()
  const queryFilename = searchParams.get('filename') ?? ''
  const apiBase = useMemo(() => getApiBase(), [])
  const filename = queryFilename
  const [layerMode, setLayerMode] = useState(defaultLayerMode)
  const [objectiveMagnification, setObjectiveMagnification] = useState(
    defaultObjectiveMagnification,
  )
  const [param1Input, setParam1Input] = useState(String(DEFAULT_PARAM1))
  const [imageSizeInput, setImageSizeInput] = useState(String(DEFAULT_IMAGE_SIZE))
  const [autoAnnotation, setAutoAnnotation] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>(
    'idle',
  )
  const [hasExtracted, setHasExtracted] = useState(false)
  const [extractedDbName, setExtractedDbName] = useState<string | null>(null)
  const [extractionStem, setExtractionStem] = useState<string | null>(null)
  const [imageCount, setImageCount] = useState<number | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [isImageLoading, setIsImageLoading] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [overlayVisible, setOverlayVisible] = useState(false)
  const [overlayStatus, setOverlayStatus] = useState<
    'idle' | 'loading' | 'running' | 'done' | 'error'
  >('idle')
  const [overlayFrames, setOverlayFrames] = useState<OverlayFrame[]>([])
  const [overlayIndex, setOverlayIndex] = useState(0)
  const [overlayError, setOverlayError] = useState<string | null>(null)
  const [overlayDbName, setOverlayDbName] = useState<string | null>(null)
  const [finishedNoticeVisible, setFinishedNoticeVisible] = useState(false)
  const overlayRunRef = useRef(0)
  const overlayAbortRef = useRef<AbortController | null>(null)
  const overlayFramesRef = useRef<OverlayFrame[]>([])
  const finishedNoticeTimeoutRef = useRef<number | null>(null)
  const layerModeRequestRef = useRef(0)
  const lastFilenameRef = useRef<string | null>(null)
  const hasManualLayerModeRef = useRef(false)

  useEffect(() => {
    const trimmed = filename.trim()
    if (!trimmed) return

    if (lastFilenameRef.current !== trimmed) {
      lastFilenameRef.current = trimmed
      hasManualLayerModeRef.current = false
    }

    const requestId = layerModeRequestRef.current + 1
    layerModeRequestRef.current = requestId
    const controller = new AbortController()

    const loadMetadata = async () => {
      try {
        const res = await fetch(
          `${apiBase}/nd2_files/${encodeURIComponent(trimmed)}/metadata`,
          { signal: controller.signal },
        )
        if (!res.ok) {
          throw new Error(`Metadata request failed (${res.status})`)
        }
        const data = (await res.json()) as Nd2FileMetadataResponse
        if (layerModeRequestRef.current !== requestId) return
        const inferred = inferLayerModeFromMetadata(data) ?? defaultLayerMode
        if (!hasManualLayerModeRef.current) {
          setLayerMode(inferred)
        }
      } catch {
        if (controller.signal.aborted) return
        if (layerModeRequestRef.current !== requestId) return
        if (!hasManualLayerModeRef.current) {
          setLayerMode(defaultLayerMode)
        }
      }
    }

    void loadMetadata()
    return () => {
      controller.abort()
    }
  }, [apiBase, filename])

  const triggerFinishedNotice = useCallback(() => {
    if (finishedNoticeTimeoutRef.current !== null) {
      window.clearTimeout(finishedNoticeTimeoutRef.current)
    }
    setFinishedNoticeVisible(true)
    finishedNoticeTimeoutRef.current = window.setTimeout(() => {
      setFinishedNoticeVisible(false)
      finishedNoticeTimeoutRef.current = null
    }, 2000)
  }, [])

  const revokeOverlayFrameUrls = useCallback((frames: OverlayFrame[]) => {
    frames.forEach((frame) => {
      URL.revokeObjectURL(frame.url)
    })
  }, [])

  useEffect(() => {
    overlayFramesRef.current = overlayFrames
  }, [overlayFrames])

  const closeOverlay = useCallback(
    (options?: { showFinished?: boolean }) => {
      overlayRunRef.current += 1
      overlayAbortRef.current?.abort()
      overlayAbortRef.current = null
      setOverlayVisible(false)
      setOverlayStatus('idle')
      setOverlayFrames((prev) => {
        revokeOverlayFrameUrls(prev)
        return []
      })
      setOverlayIndex(0)
      setOverlayError(null)
      setOverlayDbName(null)
      if (options?.showFinished) {
        triggerFinishedNotice()
      }
    },
    [revokeOverlayFrameUrls, triggerFinishedNotice],
  )

  const startOverlayPreview = useCallback(
    async (dbName: string) => {
      overlayRunRef.current += 1
      const runId = overlayRunRef.current
      overlayAbortRef.current?.abort()
      const controller = new AbortController()
      overlayAbortRef.current = controller

      setOverlayVisible(true)
      setOverlayStatus('loading')
      setOverlayFrames((prev) => {
        revokeOverlayFrameUrls(prev)
        return []
      })
      setOverlayIndex(0)
      setOverlayError(null)
      setOverlayDbName(dbName)

      try {
        const overlayParams = new URLSearchParams({
          dbname: dbName,
          draw_scale_bar: 'false',
          overlay_mode: 'raw',
          scale: String(OVERLAY_PREVIEW_SCALE),
          format: OVERLAY_PREVIEW_FORMAT,
          jpeg_quality: String(OVERLAY_PREVIEW_QUALITY),
        })
        const overlayRes = await fetch(
          `${apiBase}/get-cell-overlay-zip?${overlayParams.toString()}`,
          {
            signal: controller.signal,
            headers: { accept: 'application/zip' },
          },
        )
        if (!overlayRes.ok) {
          throw new Error(`Overlay ZIP request failed (${overlayRes.status})`)
        }
        const buffer = await overlayRes.arrayBuffer()
        const zipEntries = unzipSync(new Uint8Array(buffer))
        const manifestBytes = zipEntries['manifest.json']
        if (!manifestBytes) {
          throw new Error('Overlay manifest is missing.')
        }
        const manifest = JSON.parse(strFromU8(manifestBytes)) as unknown
        const entries = parseOverlayManifestEntries(manifest)
        const frames: OverlayFrame[] = []
        for (const entry of entries) {
          const cellId = typeof entry.cell_id === 'string' ? entry.cell_id : ''
          const file = typeof entry.file === 'string' ? entry.file : ''
          if (!cellId || !file) continue
          const imageBytes = zipEntries[file]
          if (!imageBytes) continue
          const mimeType = file.endsWith('.jpg') || file.endsWith('.jpeg')
            ? 'image/jpeg'
            : 'image/png'
          const url = URL.createObjectURL(new Blob([imageBytes], { type: mimeType }))
          frames.push({ cellId, url })
        }
        if (overlayRunRef.current !== runId) {
          revokeOverlayFrameUrls(frames)
          return
        }
        if (frames.length === 0) {
          setOverlayStatus('error')
          setOverlayError('No cells found in the extracted database.')
          return
        }
        setOverlayFrames((prev) => {
          revokeOverlayFrameUrls(prev)
          return frames
        })
        setOverlayStatus('running')
        setOverlayError(null)

        for (let index = 0; index < frames.length; index += 1) {
          if (overlayRunRef.current !== runId) return
          setOverlayIndex(index)
          await new Promise((resolve) => {
            window.setTimeout(resolve, OVERLAY_FRAME_INTERVAL_MS)
          })
        }

        if (overlayRunRef.current === runId) {
          setOverlayStatus('done')
        }
      } catch (err) {
        if (overlayRunRef.current !== runId || controller.signal.aborted) return
        setOverlayStatus('error')
        setOverlayError(
          err instanceof Error ? err.message : 'Failed to start overlay preview',
        )
      } finally {
        if (overlayRunRef.current === runId) {
          overlayAbortRef.current = null
        }
      }
    },
    [apiBase, revokeOverlayFrameUrls],
  )

  const handleSubmit = useCallback(async () => {
    if (!filename.trim()) {
      setError('Filename is required')
      return
    }
    closeOverlay()
    const param1Value = coerceInt(param1Input, DEFAULT_PARAM1, 0)
    const imageSizeValue = coerceInt(imageSizeInput, DEFAULT_IMAGE_SIZE, 1)
    setIsSubmitting(true)
    setError(null)
    setJobId(null)
    setJobStatus('running')
    setExtractionStem(null)
    setImageCount(null)
    setCurrentIndex(0)
    setImageUrl(null)
    setImageError(null)
    try {
      const payload = {
        filename: filename.trim(),
        layer_mode: layerMode,
        param1: param1Value,
        image_size: imageSizeValue,
        auto_annotation: autoAnnotation,
        objective_magnification: objectiveMagnification,
      }
      const res = await fetch(`${apiBase}/extract-cells`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const data = (await res.json()) as ExtractCellsStartResponse
      if (!data.job_id) {
        throw new Error('Job id missing from response')
      }
      setJobId(data.job_id)
      setJobStatus(data.status === 'queued' ? 'running' : data.status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start extraction')
      setIsSubmitting(false)
      setJobStatus('failed')
    }
  }, [
    apiBase,
    autoAnnotation,
    closeOverlay,
    filename,
    imageSizeInput,
    layerMode,
    objectiveMagnification,
    param1Input,
  ])

  useEffect(() => {
    if (!jobId || jobStatus !== 'running') return
    let cancelled = false

    const pollStatus = async () => {
      try {
        const res = await fetch(`${apiBase}/extract-cells/${encodeURIComponent(jobId)}`)
        if (!res.ok) {
          throw new Error(`Status check failed (${res.status})`)
        }
        const data = (await res.json()) as ExtractCellsJobStatusResponse
        if (cancelled) return
        if (data.status === 'completed') {
          if (!data.result) {
            setError('Extraction result missing')
            setJobStatus('failed')
            setIsSubmitting(false)
            return
          }
          setExtractionStem(data.result.nd2_stem)
          setHasExtracted(true)
          const nextDbName = data.result.databases?.[0]?.db_name?.trim()
          setExtractedDbName(nextDbName ? nextDbName : null)
          setJobStatus('completed')
          setIsSubmitting(false)
          if (nextDbName) {
            void startOverlayPreview(nextDbName)
          }
          return
        }
        if (data.status === 'failed') {
          setError(data.error ?? 'Extraction failed')
          setJobStatus('failed')
          setIsSubmitting(false)
          return
        }
        setJobStatus('running')
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to check extraction status')
        setJobStatus('failed')
        setIsSubmitting(false)
      }
    }

    void pollStatus()
    const intervalId = window.setInterval(pollStatus, 2000)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [apiBase, jobId, jobStatus, startOverlayPreview])

  const fetchImageCount = useCallback(
    async (stem: string) => {
      try {
        const res = await fetch(
          `${apiBase}/get-extracted-image-count?folder=${encodeURIComponent(stem)}`,
        )
        if (!res.ok) {
          throw new Error(`Image count failed (${res.status})`)
        }
        const data = (await res.json()) as { count: number }
        setImageCount(Number.isFinite(data.count) ? data.count : 0)
      } catch (err) {
        setImageCount(0)
        setImageError(err instanceof Error ? err.message : 'Failed to load image count')
      }
    },
    [apiBase],
  )

  const fetchImage = useCallback(
    async (stem: string, index: number) => {
      setIsImageLoading(true)
      setImageError(null)
      try {
        const res = await fetch(
          `${apiBase}/get-extracted-image?folder=${encodeURIComponent(stem)}&n=${index}`,
        )
        if (!res.ok) {
          throw new Error(`Image load failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        setImageUrl(url)
      } catch (err) {
        setImageUrl(null)
        setImageError(err instanceof Error ? err.message : 'Failed to load image')
      } finally {
        setIsImageLoading(false)
      }
    },
    [apiBase],
  )

  useEffect(() => {
    if (!extractionStem) return
    void fetchImageCount(extractionStem)
  }, [extractionStem, fetchImageCount])

  useEffect(() => {
    if (!extractionStem || imageCount === null) return
    if (imageCount <= 0) {
      setImageUrl(null)
      return
    }
    void fetchImage(extractionStem, currentIndex)
  }, [currentIndex, extractionStem, fetchImage, imageCount])

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [imageUrl])

  useEffect(() => {
    return () => {
      revokeOverlayFrameUrls(overlayFramesRef.current)
    }
  }, [revokeOverlayFrameUrls])

  useEffect(() => {
    return () => {
      if (finishedNoticeTimeoutRef.current !== null) {
        window.clearTimeout(finishedNoticeTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (overlayStatus !== 'done' || !overlayVisible) return
    const timeoutId = window.setTimeout(() => {
      closeOverlay({ showFinished: true })
    }, 200)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [closeOverlay, overlayStatus, overlayVisible])

  useEffect(() => {
    if (!autoAnnotation && overlayVisible) {
      closeOverlay()
    }
  }, [autoAnnotation, closeOverlay, overlayVisible])

  const overlayCurrentCellId = overlayFrames[overlayIndex]?.cellId ?? ''
  const overlayImageUrl = overlayFrames[overlayIndex]?.url ?? null
  const overlayTotal = overlayFrames.length

  return (
    <Box minH="100dvh" h="auto" bg="sand.50" color="ink.900" display="flex" flexDirection="column">
      <PageHeader
        actions={
          <>
            <ReloadButton />
            <ThemeToggleButton />
          </>
        }
      />

      <Container
        maxW="72.5rem"
        py={{ base: 4, md: 6 }}
        flex="1"
        display="flex"
        flexDirection="column"
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
                <BreadcrumbLink as={RouterLink} to="/nd2files">
                  ND2 Files
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbCurrentLink color="ink.900">Cell Extraction</BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>
        <Stack spacing="4" flex="1" minH="0">
          <Box
            display="grid"
            gridTemplateColumns={{ base: '1fr', lg: 'minmax(0, 1.15fr) minmax(0, 0.95fr)' }}
            gap="6"
            alignItems="stretch"
            flex="1"
            minH="0"
          >
            <Box
              bg="sand.100"
              border="1px solid"
              borderColor="sand.200"
              borderRadius="xl"
              p={{ base: 4, md: 5 }}
              h="full"
              display="flex"
              flexDirection="column"
              minH="0"
            >
              <Stack spacing="3" flex="1" minH="0">
                <Stack spacing="1">
                  <Text fontWeight="600">Extraction Settings</Text>
                  <Text fontSize="sm" color="ink.700">
                    Configure the inputs required for the extraction pipeline.
                  </Text>
                </Stack>
                <Separator borderColor="sand.200" />
                <Box
                  display="grid"
                  gridTemplateColumns={{ base: '1fr', md: 'repeat(4, minmax(0, 1fr))' }}
                  gap="3"
                >
                  <Stack spacing="2" gridColumn={{ base: 'auto', md: '1 / -1' }}>
                    <Text fontSize="sm" color="ink.700">
                      ND2 filename
                    </Text>
                    <Input
                      value={filename}
                      readOnly
                      placeholder="example.nd2"
                      border="1px solid"
                      borderColor="sand.200"
                      bg="sand.50"
                      color="ink.900"
                      _placeholder={{ color: 'ink.700' }}
                      _readOnly={{ opacity: 0.8 }}
                      _focusVisible={{
                        borderColor: 'tide.400',
                        boxShadow: '0 0 0 1px var(--app-accent-ring)',
                      }}
                    />
                  </Stack>

                  <Stack spacing="2">
                    <Text fontSize="sm" color="ink.700">
                      Mode
                    </Text>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={layerMode}
                        onChange={(event) => {
                          hasManualLayerModeRef.current = true
                          setLayerMode(event.target.value)
                        }}
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        {layerOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </Stack>

                  <Stack spacing="2">
                    <Text fontSize="sm" color="ink.700">
                      Objective
                    </Text>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={objectiveMagnification}
                        onChange={(event) => setObjectiveMagnification(event.target.value)}
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        {objectiveOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </Stack>

                  <Stack spacing="2">
                    <Text fontSize="sm" color="ink.700">
                      Param1
                    </Text>
                    <Input
                      type="number"
                      min={0}
                      placeholder="1-255"
                      value={param1Input}
                      onChange={(event) =>
                        setParam1Input(normalizeIntInput(event.target.value))
                      }
                      onBlur={() =>
                        setParam1Input((current) =>
                          current === '' ? String(DEFAULT_PARAM1) : current,
                        )
                      }
                      border="1px solid"
                      borderColor="sand.200"
                      bg="sand.50"
                      color="ink.900"
                      _placeholder={{ color: 'ink.700' }}
                      _focusVisible={{
                        borderColor: 'tide.400',
                        boxShadow: '0 0 0 1px var(--app-accent-ring)',
                      }}
                    />
                  </Stack>

                  <Stack spacing="2">
                    <Text fontSize="sm" color="ink.700">
                      Image Size
                    </Text>
                    <Input
                      type="number"
                      min={1}
                      value={imageSizeInput}
                      onChange={(event) =>
                        setImageSizeInput(normalizeIntInput(event.target.value))
                      }
                      onBlur={() =>
                        setImageSizeInput((current) =>
                          current === '' ? String(DEFAULT_IMAGE_SIZE) : current,
                        )
                      }
                      border="1px solid"
                      borderColor="sand.200"
                      bg="sand.50"
                      color="ink.900"
                      _focusVisible={{
                        borderColor: 'tide.400',
                        boxShadow: '0 0 0 1px var(--app-accent-ring)',
                      }}
                    />
                  </Stack>

                  <Stack spacing="2">
                    <Text fontSize="sm" color="ink.700">
                      Auto Annotation
                    </Text>
                    <Checkbox.Root
                      checked={autoAnnotation}
                      onCheckedChange={(details) =>
                        setAutoAnnotation(details.checked === true)
                      }
                      colorPalette="tide"
                      display="flex"
                      alignItems="center"
                      gap="2"
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control
                        borderColor="tide.400"
                        _checked={{
                          bg: 'tide.500',
                          borderColor: 'tide.500',
                          color: 'ink.900',
                        }}
                      />
                      <Checkbox.Label fontSize="sm" color="ink.700" whiteSpace="nowrap">
                        Auto Annotation
                      </Checkbox.Label>
                    </Checkbox.Root>
                  </Stack>
                </Box>

                <HStack justify="flex-end" flexWrap="wrap" gap="2">
                  {hasExtracted && extractedDbName && (
                    <HStack spacing="2" mr="auto">
                      <Button
                        size="sm"
                        bg="tide.500"
                        color="white"
                        _hover={{ bg: 'tide.400' }}
                        as={RouterLink}
                        to={`/databases?search_dbname=${encodeURIComponent(extractedDbName)}`}
                      >
                        Go to database
                      </Button>
                      <Button
                        size="sm"
                        bg="tide.500"
                        color="white"
                        _hover={{ bg: 'tide.400' }}
                        as={RouterLink}
                        to={`/annotation?dbname=${encodeURIComponent(extractedDbName)}`}
                      >
                        Go to annotation
                      </Button>
                    </HStack>
                  )}
                  <Button
                    size="sm"
                    bg="tide.500"
                    color="white"
                    _hover={{ bg: 'tide.400' }}
                    onClick={handleSubmit}
                    loading={isSubmitting}
                  >
                    {isSubmitting ? 'Extracting...' : hasExtracted ? 'Re-extract' : 'Extract Cells'}
                  </Button>
                </HStack>
              </Stack>
            </Box>

            <Box
              bg="sand.100"
              border="1px solid"
              borderColor="sand.200"
              borderRadius="xl"
              p={{ base: 4, md: 5 }}
              h="full"
              display="flex"
              flexDirection="column"
              minH="0"
            >
              <Stack spacing="3" flex="1" minH="0">
                <Stack spacing="1">
                  <Text fontWeight="600">Extraction Preview</Text>
                  {(imageCount === null || imageCount <= 0) && (
                    <Text fontSize="sm" color="ink.700">
                      {imageCount === null
                        ? 'Run extraction to preview 0.png.'
                        : 'No extracted images found.'}
                    </Text>
                  )}
                </Stack>

                <Box
                  bg="sand.200"
                  borderRadius="lg"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  overflow="hidden"
                  flex="1"
                  minH="0"
                >
                  {imageUrl ? (
                    <Box
                      as="img"
                      src={imageUrl}
                      alt="Extracted cell preview"
                      maxW="100%"
                      maxH="100%"
                      w="auto"
                      h="auto"
                      objectFit="contain"
                    />
                  ) : (
                    <Flex align="center" justify="center" color="ink.700" fontSize="sm">
                      {isImageLoading
                        ? 'Loading image...'
                        : imageError
                          ? imageError
                          : 'No preview available.'}
                    </Flex>
                  )}
                </Box>

                {imageCount !== null && imageCount > 0 && (
                  <Stack spacing="2">
                    <HStack justify="space-between">
                      <Text fontSize="xs" color="ink.700">
                        Frame {currentIndex}
                      </Text>
                      <Text fontSize="xs" color="ink.700">
                        / {Math.max(imageCount - 1, 0)}
                      </Text>
                    </HStack>
                    <Slider.Root
                      value={[currentIndex]}
                      min={0}
                      max={Math.max(imageCount - 1, 0)}
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
                  </Stack>
                )}
              </Stack>
            </Box>

          </Box>

          {error && (
            <Box
              bg="sand.100"
              border="1px solid"
              borderColor="violet.400"
              borderRadius="lg"
              px="4"
              py="3"
            >
              <Text fontSize="sm" color="violet.300">
                {error}
              </Text>
            </Box>
          )}
        </Stack>
      </Container>

      {autoAnnotation && overlayVisible && (
        <Box
          position="fixed"
          inset="0"
          bg="rgba(11, 13, 16, 0.55)"
          zIndex={1400}
          display="flex"
          alignItems="center"
          justifyContent="center"
          px="4"
          onClick={() => closeOverlay({ showFinished: overlayStatus === 'done' })}
        >
          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            p="4"
            w={OVERLAY_PREVIEW_SIZE}
            maxH="85vh"
            display="flex"
            flexDirection="column"
            gap="3"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <HStack justify="space-between" align="center" spacing="3" flexWrap="wrap">
              <Stack spacing="1">
                <Text fontSize="sm" fontWeight="600" color="ink.900">
                  AutoAnnotating manual labels ...
                </Text>
                <Text fontSize="xs" color="ink.700">
                  Overlay raw sequence{overlayDbName ? ` · ${overlayDbName}` : ''}
                </Text>
              </Stack>
              <Button
                size="xs"
                variant="outline"
                borderColor="tide.500"
                bg="tide.500"
                color="white"
                _hover={{ bg: 'tide.400' }}
                onClick={() => closeOverlay({ showFinished: overlayStatus === 'done' })}
              >
                Close
              </Button>
            </HStack>

            {overlayStatus === 'loading' && (
              <Text fontSize="sm" color="ink.700">
                Loading cells...
              </Text>
            )}
            {overlayStatus === 'error' && overlayError && (
              <Text fontSize="sm" color="violet.300">
                {overlayError}
              </Text>
            )}
            {overlayStatus !== 'error' && (
              <Stack spacing="1">
                <Text fontSize="xs" color="ink.700">
                  {overlayTotal > 0
                    ? `Cell ${overlayIndex + 1} / ${overlayTotal}`
                    : 'Preparing overlay sequence...'}
                </Text>
                {overlayCurrentCellId && (
                  <Text fontSize="xs" color="ink.700">
                    {overlayCurrentCellId}
                  </Text>
                )}
              </Stack>
            )}

            <Box
              bg="sand.200"
              borderRadius="lg"
              display="flex"
              alignItems="center"
              justifyContent="center"
              overflow="hidden"
              flex="1"
              minH="240px"
            >
              <AspectRatio
                ratio={1}
                w="100%"
              >
                {overlayImageUrl ? (
                  <Box
                    as="img"
                    src={overlayImageUrl}
                    alt={
                      overlayCurrentCellId ? `${overlayCurrentCellId} overlay` : 'Cell overlay'
                    }
                    w="100%"
                    h="100%"
                    objectFit="contain"
                    imageRendering="pixelated"
                  />
                ) : (
                  <Flex align="center" justify="center" color="ink.700" fontSize="sm">
                    {overlayStatus === 'done'
                      ? 'Overlay sequence complete.'
                      : overlayError
                        ? overlayError
                        : 'Generating overlays...'}
                  </Flex>
                )}
              </AspectRatio>
            </Box>
          </Box>
        </Box>
      )}

      {finishedNoticeVisible && (
        <Box
          position="fixed"
          inset="0"
          display="flex"
          alignItems="center"
          justifyContent="center"
          zIndex={1500}
          pointerEvents="none"
        >
          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="lg"
            px="6"
            py="3"
            boxShadow="lg"
          >
            <Text fontSize="sm" fontWeight="600" color="ink.900">
              AutoAnnotation Finished.
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
