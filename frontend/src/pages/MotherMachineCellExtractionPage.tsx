import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import {
  Badge,
  Box,
  BreadcrumbCurrentLink,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbRoot,
  BreadcrumbSeparator,
  Button,
  Flex,
  Grid,
  Heading,
  HStack,
  Icon,
  Input,
  Slider,
  Stack,
  Text,
} from '@chakra-ui/react'
import {
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Download,
  Eye,
  Play,
  RotateCcw,
  Settings2,
} from 'lucide-react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import PageContainer from '../components/PageContainer'
import MotherMachineHelpDrawer from '../components/MotherMachineHelpDrawer'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type ChannelManifest = {
  channel_id: number
  reference_roi: { x0: number; y0: number; x1: number; y1: number }
  frame_cell_counts: number[]
}

type ViewManifest = {
  view_index: number
  configured: boolean
  description: string
  channels: ChannelManifest[]
}

type DatasetManifest = {
  filename: string
  database: string
  model: string
  niter?: number
  field_count: number
  timeframe_count: number
  configured_field_count: number
  total_cell_instances: number
  elapsed_seconds: number
  views: ViewManifest[]
}

type JobStatus = {
  job_id: string
  filename: string
  niter: number
  status: 'running' | 'completed' | 'failed'
  progress?: {
    stage?: string
    message?: string
    processed_frames?: number
    total_frames?: number
  }
  result?: unknown
  error?: string
}

const responseError = async (response: Response, fallback: string) => {
  try {
    const body = (await response.json()) as { detail?: string }
    return body.detail || `${fallback} (${response.status})`
  } catch {
    return `${fallback} (${response.status})`
  }
}

export default function MotherMachineCellExtractionPage() {
  const [searchParams] = useSearchParams()
  const filename = searchParams.get('filename')?.trim() ?? ''
  const apiBase = useMemo(() => getApiBase(), [])
  const jobStorageKey = useMemo(
    () => `mother-machine-extraction-job:${filename}`,
    [filename],
  )
  const [dataset, setDataset] = useState<DatasetManifest | null>(null)
  const [isDatasetLoading, setIsDatasetLoading] = useState(true)
  const [job, setJob] = useState<JobStatus | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewIndex, setViewIndex] = useState(0)
  const [channelId, setChannelId] = useState<number | null>(null)
  const [timeFrame, setTimeFrame] = useState(0)
  const [imageMode, setImageMode] = useState<'raw' | 'overlay'>('overlay')
  const [isAligned, setIsAligned] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [contourLoading, setContourLoading] = useState(false)
  const [contourError, setContourError] = useState(false)
  const [exportingGif, setExportingGif] = useState<'preview' | 'contours' | null>(null)
  const [iterationNumber, setIterationNumber] = useState('500')

  const loadDataset = useCallback(async () => {
    if (!filename) {
      setDataset(null)
      setIsDatasetLoading(false)
      return false
    }
    try {
      const response = await fetch(
        `${apiBase}/mother-machine/datasets/${encodeURIComponent(filename)}`,
      )
      if (response.status === 404) {
        setDataset(null)
        return false
      }
      if (!response.ok) throw new Error(await responseError(response, 'Failed to load dataset'))
      const manifest = (await response.json()) as DatasetManifest
      setDataset(manifest)
      setIterationNumber(String(manifest.niter ?? 500))
      const firstConfigured = manifest.views.find((view) => view.configured)
      const initialView = firstConfigured?.view_index ?? 0
      setViewIndex(initialView)
      setChannelId(firstConfigured?.channels[0]?.channel_id ?? null)
      setTimeFrame(0)
      setError(null)
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load dataset')
      return false
    } finally {
      setIsDatasetLoading(false)
    }
  }, [apiBase, filename])

  useEffect(() => {
    setIsDatasetLoading(true)
    void loadDataset()
  }, [loadDataset])

  useEffect(() => {
    if (!filename) return
    let storedJobId: string | null = null
    try {
      storedJobId = window.localStorage.getItem(jobStorageKey)
    } catch {
      return
    }
    if (!storedJobId) return

    const controller = new AbortController()
    fetch(`${apiBase}/mother-machine/extractions/${encodeURIComponent(storedJobId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) {
          window.localStorage.removeItem(jobStorageKey)
          return null
        }
        if (!response.ok) throw new Error(await responseError(response, 'Failed to restore extraction'))
        return response.json() as Promise<JobStatus>
      })
      .then((restoredJob) => {
        if (!restoredJob || controller.signal.aborted) return
        setJob(restoredJob)
        setIterationNumber(String(restoredJob.niter))
        if (restoredJob.status !== 'running') {
          window.localStorage.removeItem(jobStorageKey)
          if (restoredJob.status === 'completed') {
            setIsDatasetLoading(true)
            void loadDataset()
          } else {
            setError(restoredJob.error || 'Extraction failed')
          }
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : 'Failed to restore extraction')
        }
      })
    return () => controller.abort()
  }, [apiBase, filename, jobStorageKey, loadDataset])

  useEffect(() => {
    if (!job || job.status !== 'running') return
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiBase}/mother-machine/extractions/${job.job_id}`)
        if (!response.ok) throw new Error(await responseError(response, 'Failed to check extraction'))
        const next = (await response.json()) as JobStatus
        setJob(next)
        if (next.status === 'completed') {
          window.localStorage.removeItem(jobStorageKey)
          setIsDatasetLoading(true)
          await loadDataset()
        } else if (next.status === 'failed') {
          window.localStorage.removeItem(jobStorageKey)
          setError(next.error || 'Extraction failed')
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to check extraction')
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [apiBase, job, jobStorageKey, loadDataset])

  const selectedView = useMemo(
    () => dataset?.views.find((view) => view.view_index === viewIndex) ?? null,
    [dataset, viewIndex],
  )
  const selectedChannel = useMemo(
    () => selectedView?.channels.find((channel) => channel.channel_id === channelId) ?? null,
    [channelId, selectedView],
  )

  const selectView = useCallback(
    (nextViewIndex: number) => {
      if (!dataset) return
      const nextView = dataset.views.find((view) => view.view_index === nextViewIndex)
      if (!nextView) return
      setViewIndex(nextViewIndex)
      setChannelId(nextView.channels[0]?.channel_id ?? null)
      setTimeFrame(0)
      setIsPlaying(false)
    },
    [dataset],
  )

  useEffect(() => {
    if (!isPlaying || !dataset || !selectedChannel) return
    const timer = window.setInterval(() => {
      setTimeFrame((current) => (current + 1) % dataset.timeframe_count)
    }, 350)
    return () => window.clearInterval(timer)
  }, [dataset, isPlaying, selectedChannel])

  const startExtraction = useCallback(async () => {
    if (!filename || isStarting || job?.status === 'running') return
    const niter = Number(iterationNumber)
    if (!Number.isInteger(niter) || niter < 1 || niter > 5000) {
      setError('Iteration number must be an integer from 1 to 5000.')
      return
    }
    if (dataset && !window.confirm('Re-run extraction and replace the current Mother Machine dataset?')) {
      return
    }
    setIsStarting(true)
    setError(null)
    setIsPlaying(false)
    try {
      const response = await fetch(`${apiBase}/mother-machine/extractions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, niter }),
      })
      if (!response.ok) throw new Error(await responseError(response, 'Failed to start extraction'))
      const startedJob = (await response.json()) as JobStatus
      window.localStorage.setItem(jobStorageKey, startedJob.job_id)
      setJob(startedJob)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to start extraction')
    } finally {
      setIsStarting(false)
    }
  }, [apiBase, dataset, filename, isStarting, iterationNumber, job?.status, jobStorageKey])

  const imageUrl = useMemo(() => {
    if (!dataset || channelId === null) return ''
    if (isAligned) {
      const params = new URLSearchParams({
        view_index: String(viewIndex),
        roi_id: String(channelId),
        kind: imageMode,
      })
      return `${apiBase}/mother-machine/datasets/${encodeURIComponent(filename)}/aligned.png?${params}`
    }
    const params = new URLSearchParams({
      view_index: String(viewIndex),
      roi_id: String(channelId),
      time_frame: String(timeFrame),
      mode: imageMode,
    })
    return `${apiBase}/mother-machine/datasets/${encodeURIComponent(filename)}/image?${params}`
  }, [apiBase, channelId, dataset, filename, imageMode, isAligned, timeFrame, viewIndex])

  const contourUrl = useMemo(() => {
    if (!dataset || channelId === null) return ''
    const params = new URLSearchParams({
      view_index: String(viewIndex),
      roi_id: String(channelId),
      time_frame: String(timeFrame),
    })
    return `${apiBase}/mother-machine/datasets/${encodeURIComponent(filename)}/contours?${params}`
  }, [apiBase, channelId, dataset, filename, timeFrame, viewIndex])

  useEffect(() => {
    if (!imageUrl) return
    setImageLoading(true)
    setImageError(false)
  }, [imageUrl])

  useEffect(() => {
    if (!contourUrl) return
    setContourLoading(true)
    setContourError(false)
  }, [contourUrl])

  const exportGif = useCallback(async (
    kind: 'raw' | 'overlay' | 'contours',
    target: 'preview' | 'contours',
  ) => {
    if (!dataset || channelId === null || exportingGif) return
    setExportingGif(target)
    setError(null)
    try {
      const params = new URLSearchParams({
        view_index: String(viewIndex),
        roi_id: String(channelId),
        kind,
      })
      const response = await fetch(
        `${apiBase}/mother-machine/datasets/${encodeURIComponent(filename)}/animation.gif?${params}`,
      )
      if (!response.ok) throw new Error(await responseError(response, 'GIF export failed'))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${filename.replace(/\.nd2$/i, '')}-field-${viewIndex + 1}-roi-${channelId}-${kind}.gif`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to export GIF')
    } finally {
      setExportingGif(null)
    }
  }, [apiBase, channelId, dataset, exportingGif, filename, viewIndex])

  const progressPercent = useMemo<number | null>(() => {
    const processed = job?.progress?.processed_frames
    const total = job?.progress?.total_frames
    if (processed === undefined || !total || processed <= 0) return null
    return Math.min(100, Math.round((processed / total) * 100))
  }, [job])
  const iterationNumberIsValid = useMemo(() => {
    const value = Number(iterationNumber)
    return Number.isInteger(value) && value >= 1 && value <= 5000
  }, [iterationNumber])
  return (
    <Box minH="100vh" bg="sand.50" color="ink.900">
      <PageHeader actions={<><ReloadButton /><ThemeToggleButton /><MotherMachineHelpDrawer page="cell-extraction" /></>} />
      <PageContainer>
        <PageBreadcrumb>
          <BreadcrumbRoot fontSize="sm" color="ink.700">
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink as={RouterLink} to="/">Home</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem><BreadcrumbLink as={RouterLink} to="/mother-machine/nd2files">Mother Machine</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem><BreadcrumbCurrentLink color="ink.900">Cell Extraction</BreadcrumbCurrentLink></BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>

        <Stack spacing="6">
          <Stack spacing="2">
            <HStack justify="space-between" align="flex-start" flexWrap="wrap" gap="3">
              <Box>
                <Heading size="lg">Mother Machine cell extraction</Heading>
                <Text color="ink.700" fontSize="sm" mt="1">
                  {filename || 'No ND2 file selected'}
                </Text>
              </Box>
              <Button as={RouterLink} to="/mother-machine/nd2files" variant="outline">
                Back to ND2 files
              </Button>
            </HStack>
          </Stack>

          <Box bg="sand.100" border="1px solid" borderColor="sand.200" borderRadius="xl" p="5">
            <HStack justify="space-between" align="flex-start" gap="4" flexWrap="wrap">
              <HStack align="flex-start" spacing="3">
                <Flex w="9" h="9" align="center" justify="center" bg="sand.200" borderRadius="md">
                  <Icon as={Settings2} color="tide.400" />
                </Flex>
                <Box>
                  <Heading size="sm">Parameters</Heading>
                  <Box mt="3">
                    <Text as="label" htmlFor="mother-machine-niter" fontSize="sm" fontWeight="600">
                      Iteration number
                    </Text>
                    <Input
                      id="mother-machine-niter"
                      type="number"
                      min={1}
                      max={5000}
                      step={1}
                      value={iterationNumber}
                      onChange={(event) => setIterationNumber(event.target.value)}
                      mt="1"
                      w="10rem"
                      bg="sand.50"
                      borderColor={iterationNumberIsValid ? 'sand.300' : 'red.400'}
                      disabled={job?.status === 'running'}
                    />
                  </Box>
                </Box>
              </HStack>
              <Button
                onClick={() => void startExtraction()}
                loading={isStarting}
                disabled={!filename || !iterationNumberIsValid || job?.status === 'running'}
                variant="outline"
              >
                <Icon as={dataset ? RotateCcw : Play} /> {dataset ? 'Re-extract' : 'Extract'}
              </Button>
            </HStack>

            {job?.status === 'running' && (
              <Stack spacing="2" mt="5">
                <HStack justify="space-between">
                  <Text fontSize="sm">{job.progress?.message || 'Extracting cells…'}</Text>
                  <Text fontSize="sm" fontWeight="600">
                    {progressPercent === null ? 'Working…' : `${progressPercent}%`}
                  </Text>
                </HStack>
                <Box h="2" bg="sand.200" borderRadius="full" overflow="hidden">
                  <Box
                    h="full"
                    w={`${Math.max(progressPercent ?? 2, 2)}%`}
                    bg="tide.400"
                    transition="width 0.2s ease"
                  />
                </Box>
                <Text fontSize="xs" color="ink.700">
                  The job continues on the backend if you leave this page.
                </Text>
              </Stack>
            )}
          </Box>

          {error && (
            <Box p="4" borderRadius="lg" bg="red.50" border="1px solid" borderColor="red.200">
              <Text color="red.700" fontSize="sm">{error}</Text>
            </Box>
          )}

          {isDatasetLoading && <Text color="ink.700">Loading extracted dataset…</Text>}
          {!isDatasetLoading && !dataset && job?.status !== 'running' && (
            <Box p="8" textAlign="center" border="1px dashed" borderColor="sand.300" borderRadius="xl">
              <Heading size="sm">No extracted dataset yet</Heading>
              <Text color="ink.700" fontSize="sm" mt="2">Press Extract to build the field → ROI → time-frame review dataset.</Text>
            </Box>
          )}

          {dataset && (
            <Stack spacing="5">
              <Box bg="sand.100" border="1px solid" borderColor="sand.200" borderRadius="xl" p={{ base: 4, md: 5 }}>
                <HStack justify="space-between" mb="3" flexWrap="wrap" gap="2">
                  <Box>
                    <Heading size="sm">Field of view {viewIndex + 1}</Heading>
                    <Text fontSize="xs" color="ink.700">ND2 P index {viewIndex} · Page {viewIndex + 1} of {dataset.field_count}</Text>
                  </Box>
                  <HStack spacing="1">
                    <Button size="xs" variant="outline" onClick={() => selectView(viewIndex - 1)} disabled={viewIndex === 0} aria-label="Previous field">
                      <Icon as={ChevronLeft} />
                    </Button>
                    {dataset.views.map((view) => (
                      <Button
                        key={view.view_index}
                        size="xs"
                        minW="8"
                        variant={view.view_index === viewIndex ? 'solid' : 'outline'}
                        bg={view.view_index === viewIndex ? 'tide.500' : undefined}
                        color={view.view_index === viewIndex ? 'white' : undefined}
                        borderStyle={view.configured ? 'solid' : 'dashed'}
                        onClick={() => selectView(view.view_index)}
                        aria-label={`Field ${view.view_index + 1}`}
                      >
                        {view.view_index + 1}
                      </Button>
                    ))}
                    <Button size="xs" variant="outline" onClick={() => selectView(viewIndex + 1)} disabled={viewIndex >= dataset.field_count - 1} aria-label="Next field">
                      <Icon as={ChevronRight} />
                    </Button>
                  </HStack>
                </HStack>
                <Text fontSize="sm" color="ink.700" mb="5">{selectedView?.description}</Text>

                {!selectedView?.configured && (
                  <Box p="8" textAlign="center" border="1px dashed" borderColor="sand.300" borderRadius="lg">
                    <Heading size="sm">Channel definition not configured</Heading>
                    <Text mt="2" fontSize="sm" color="ink.700">
                      This field is kept as a page because the ND2 contains it, but the current PoC config has no ROI definitions for this P index.
                    </Text>
                  </Box>
                )}

                {selectedView?.configured && selectedChannel && (
                  <Grid templateColumns={{ base: '1fr', lg: '220px minmax(0, 1fr)' }} gap="5">
                    <Stack spacing="3">
                      <HStack justify="space-between">
                        <Heading size="xs">ROI / channel</Heading>
                        <Badge>{selectedView.channels.length} ROIs</Badge>
                      </HStack>
                      <Grid templateColumns={{ base: 'repeat(4, 1fr)', lg: 'repeat(2, 1fr)' }} gap="2" maxH={{ lg: '520px' }} overflowY="auto">
                        {selectedView.channels.map((channel) => (
                          <Button
                            key={channel.channel_id}
                            size="sm"
                            variant={channel.channel_id === channelId ? 'solid' : 'outline'}
                            bg={channel.channel_id === channelId ? 'tide.500' : undefined}
                            color={channel.channel_id === channelId ? 'white' : undefined}
                            onClick={() => {
                              setChannelId(channel.channel_id)
                              setTimeFrame(0)
                              setIsPlaying(false)
                            }}
                          >
                            ROI {channel.channel_id}
                          </Button>
                        ))}
                      </Grid>
                    </Stack>

                    <Stack spacing="4" minW="0">
                      <HStack justify="space-between" flexWrap="wrap" gap="2">
                        <HStack spacing="2">
                          <Badge colorPalette="tide">ROI {selectedChannel.channel_id}</Badge>
                          <Text fontSize="sm" color="ink.700">Frame {timeFrame + 1} / {dataset.timeframe_count}</Text>
                        </HStack>
                        <HStack spacing="1">
                          <Button size="xs" variant={imageMode === 'raw' ? 'solid' : 'outline'} onClick={() => setImageMode('raw')}>Raw</Button>
                          <Button size="xs" variant={imageMode === 'overlay' ? 'solid' : 'outline'} bg={imageMode === 'overlay' ? 'tide.500' : undefined} color={imageMode === 'overlay' ? 'white' : undefined} onClick={() => setImageMode('overlay')}>
                            <Icon as={Eye} /> Overlay
                          </Button>
                          <Button size="xs" variant={isAligned ? 'solid' : 'outline'} bg={isAligned ? 'tide.500' : undefined} color={isAligned ? 'white' : undefined} onClick={() => { setIsAligned((current) => !current); setIsPlaying(false) }}>
                            Aligned
                          </Button>
                        </HStack>
                      </HStack>

                      {isAligned ? (
                        <Stack spacing="2">
                          <Flex
                            minH={{ base: '18rem', md: '24rem' }}
                            bg="#080a0d"
                            borderRadius="lg"
                            align="center"
                            justify="center"
                            p="3"
                            position="relative"
                            overflow="auto"
                          >
                            {imageUrl && !imageError && (
                              <Box
                                key={imageUrl}
                                as="img"
                                src={imageUrl}
                                alt={`Aligned time frames for field ${viewIndex + 1}, ROI ${channelId}`}
                                maxW="none"
                                maxH="34rem"
                                objectFit="contain"
                                imageRendering="auto"
                                onLoad={() => setImageLoading(false)}
                                onError={() => { setImageLoading(false); setImageError(true) }}
                              />
                            )}
                            {imageLoading && <Text position="absolute" color="whiteAlpha.700" fontSize="sm">Building aligned image…</Text>}
                            {imageError && <Text color="red.300" fontSize="sm">Aligned image could not be loaded.</Text>}
                          </Flex>
                          <Button
                            size="sm"
                            variant="outline"
                            as="a"
                            href={imageUrl}
                            download={`${filename.replace(/\.nd2$/i, '')}-field-${viewIndex + 1}-roi-${channelId}-${imageMode}-aligned.png`}
                          >
                            <Icon as={Download} /> Download aligned PNG
                          </Button>
                        </Stack>
                      ) : (
                      <Grid templateColumns={{ base: '1fr', xl: 'repeat(2, minmax(0, 1fr))' }} gap="4">
                        <Stack spacing="2">
                          <Flex
                            aspectRatio="1 / 1"
                            bg="#080a0d"
                            borderRadius="lg"
                            align="center"
                            justify="center"
                            p="3"
                            position="relative"
                            overflow="hidden"
                          >
                            {imageUrl && !imageError && (
                              <Box
                                key={imageUrl}
                                as="img"
                                src={imageUrl}
                                alt={`Field ${viewIndex + 1}, ROI ${channelId}, frame ${timeFrame + 1}`}
                                w="100%"
                                h="100%"
                                objectFit="contain"
                                imageRendering="auto"
                                onLoad={() => setImageLoading(false)}
                                onError={() => { setImageLoading(false); setImageError(true) }}
                              />
                            )}
                            {imageLoading && <Text position="absolute" color="whiteAlpha.700" fontSize="sm">Loading frame…</Text>}
                            {imageError && <Text color="red.300" fontSize="sm">Preview image could not be loaded.</Text>}
                          </Flex>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void exportGif(imageMode, 'preview')}
                            loading={exportingGif === 'preview'}
                            disabled={exportingGif !== null}
                          >
                            <Icon as={Download} /> Export as GIF
                          </Button>
                        </Stack>

                        <Stack spacing="2">
                          <Flex
                            aspectRatio="1 / 1"
                            bg="white"
                            borderRadius="lg"
                            align="center"
                            justify="center"
                            position="relative"
                            overflow="hidden"
                          >
                            {contourUrl && !contourError && (
                              <Box
                                key={contourUrl}
                                as="img"
                                src={contourUrl}
                                alt={`Contours for field ${viewIndex + 1}, ROI ${channelId}, frame ${timeFrame + 1}`}
                                w="100%"
                                h="100%"
                                objectFit="contain"
                                onLoad={() => setContourLoading(false)}
                                onError={() => { setContourLoading(false); setContourError(true) }}
                              />
                            )}
                            {contourLoading && <Text position="absolute" color="ink.700" fontSize="sm">Drawing contours…</Text>}
                            {contourError && <Text color="red.300" fontSize="sm">Contour plot could not be loaded.</Text>}
                          </Flex>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void exportGif('contours', 'contours')}
                            loading={exportingGif === 'contours'}
                            disabled={exportingGif !== null}
                          >
                            <Icon as={Download} /> Export as GIF
                          </Button>
                        </Stack>
                      </Grid>
                      )}

                      {!isAligned && <HStack spacing="3" align="center">
                        <Button size="sm" variant="outline" onClick={() => setIsPlaying((current) => !current)} aria-label={isPlaying ? 'Stop playback' : 'Play time frames'}>
                          <Icon as={isPlaying ? CircleStop : Play} /> {isPlaying ? 'Stop' : 'Play'}
                        </Button>
                        <Slider.Root
                          flex="1"
                          value={[timeFrame]}
                          min={0}
                          max={Math.max(dataset.timeframe_count - 1, 0)}
                          step={1}
                          onValueChange={(details) => {
                            setIsPlaying(false)
                            setTimeFrame(details.value[0] ?? 0)
                          }}
                        >
                          <Slider.Control>
                            <Slider.Track bg="sand.200"><Slider.Range bg="tide.400" /></Slider.Track>
                            <Slider.Thumb index={0} />
                          </Slider.Control>
                        </Slider.Root>
                        <Text minW="64px" textAlign="right" fontSize="sm" fontWeight="600">T {timeFrame}</Text>
                      </HStack>}

                    </Stack>
                  </Grid>
                )}
              </Box>
            </Stack>
          )}
        </Stack>
      </PageContainer>
    </Box>
  )
}
