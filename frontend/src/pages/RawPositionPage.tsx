import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Box,
  BreadcrumbCurrentLink,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbRoot,
  BreadcrumbSeparator,
  Button,
  Container,
  Flex,
  HStack,
  Icon,
  NativeSelect,
  Separator,
  Slider,
  Stack,
  Text,
} from '@chakra-ui/react'
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type PositionFrameSummary = {
  frame: number
  cell_count: number
  positioned_count: number
}

type PositionBounds = {
  min_x: number | null
  min_y: number | null
  max_x: number | null
  max_y: number | null
}
type ConcretePositionBounds = {
  min_x: number
  min_y: number
  max_x: number
  max_y: number
}

type PositionCell = {
  cell_id: string
  position_x: number
  position_y: number
  manual_label: string | null
  contour: number[][]
  image_x?: number
  image_y?: number
  image_width?: number
  image_height?: number
  jet_image?: string | null
}

type PositionFramePayload = {
  frame: number
  cell_count: number
  positioned_count: number
  missing_position_count: number
  invalid_contour_count: number
  bounds: PositionBounds
  fluorescence_channel?: FluorescenceChannel
  cells: PositionCell[]
}

type RawPositionViewMode = 'jet' | 'contour'
type FluorescenceChannel = 'fluo1' | 'fluo2'

const DEFAULT_FIELD_SIZE = 2048
const JET_MIN_COLOR = '#000080'

const hasBounds = (bounds: PositionBounds | null): bounds is ConcretePositionBounds =>
  Boolean(
    bounds &&
      bounds.min_x !== null &&
      bounds.min_y !== null &&
      bounds.max_x !== null &&
      bounds.max_y !== null,
  )

const buildPolygonPoints = (points: number[][]) =>
  points
    .filter((point) => point.length >= 2)
    .map(([x, y]) => `${x},${y}`)
    .join(' ')

const formatRange = (
  bounds: ConcretePositionBounds | null,
  axis: 'x' | 'y',
) => {
  if (!bounds) return '-'
  if (axis === 'x') {
    return `${bounds.min_x.toFixed(1)} - ${bounds.max_x.toFixed(1)}`
  }
  return `${bounds.min_y.toFixed(1)} - ${bounds.max_y.toFixed(1)}`
}

const formatCount = (value: number) => value.toLocaleString('en-US')

export default function RawPositionPage() {
  const [searchParams] = useSearchParams()
  const dbName = searchParams.get('dbname') ?? ''
  const apiBase = useMemo(() => getApiBase(), [])
  const databasesPagePath = dbName
    ? `/databases?search_dbname=${encodeURIComponent(dbName)}`
    : '/databases'

  const [frames, setFrames] = useState<PositionFrameSummary[]>([])
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null)
  const [frameData, setFrameData] = useState<PositionFramePayload | null>(null)
  const [isLoadingFrames, setIsLoadingFrames] = useState(false)
  const [isLoadingFrame, setIsLoadingFrame] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<RawPositionViewMode>('jet')
  const [fluorescenceChannel, setFluorescenceChannel] =
    useState<FluorescenceChannel>('fluo1')

  const selectedFrameIndex = useMemo(() => {
    if (selectedFrame === null) return -1
    return frames.findIndex((frame) => frame.frame === selectedFrame)
  }, [frames, selectedFrame])
  const selectedSummary =
    selectedFrameIndex >= 0 ? frames[selectedFrameIndex] : null
  const canGoPrev = selectedFrameIndex > 0
  const canGoNext =
    selectedFrameIndex >= 0 && selectedFrameIndex < frames.length - 1

  const fetchFrames = useCallback(async () => {
    if (!dbName) {
      setFrames([])
      setSelectedFrame(null)
      setError('Database is required')
      return
    }
    setIsLoadingFrames(true)
    setError(null)
    try {
      const params = new URLSearchParams({ dbname: dbName })
      const res = await fetch(`${apiBase}/get-cell-position-frames?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const data = (await res.json()) as { frames?: PositionFrameSummary[] }
      const nextFrames = Array.isArray(data.frames) ? data.frames : []
      setFrames(nextFrames)
      setSelectedFrame((prev) => {
        if (prev !== null && nextFrames.some((frame) => frame.frame === prev)) {
          return prev
        }
        return nextFrames[0]?.frame ?? null
      })
    } catch (err) {
      setFrames([])
      setSelectedFrame(null)
      setError(err instanceof Error ? err.message : 'Failed to load frames')
    } finally {
      setIsLoadingFrames(false)
    }
  }, [apiBase, dbName])

  const fetchFrameData = useCallback(
    async (frame: number) => {
      setIsLoadingFrame(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          frame: String(frame),
          fluorescence_channel: fluorescenceChannel,
          include_fluorescence: String(viewMode === 'jet'),
        })
        const res = await fetch(`${apiBase}/get-cell-position-frame?${params.toString()}`, {
          headers: { accept: 'application/json' },
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        setFrameData((await res.json()) as PositionFramePayload)
      } catch (err) {
        setFrameData(null)
        setError(err instanceof Error ? err.message : 'Failed to load frame')
      } finally {
        setIsLoadingFrame(false)
      }
    },
    [apiBase, dbName, fluorescenceChannel, viewMode],
  )

  useEffect(() => {
    void fetchFrames()
  }, [fetchFrames])

  useEffect(() => {
    if (selectedFrame === null) {
      setFrameData(null)
      return
    }
    void fetchFrameData(selectedFrame)
  }, [fetchFrameData, selectedFrame])

  const viewBox = useMemo(() => {
    const bounds = frameData?.bounds ?? null
    if (!hasBounds(bounds)) {
      return `0 0 ${DEFAULT_FIELD_SIZE} ${DEFAULT_FIELD_SIZE}`
    }
    const { min_x, min_y, max_x, max_y } = bounds
    const minX = Math.min(0, min_x)
    const minY = Math.min(0, min_y)
    const maxX = Math.max(DEFAULT_FIELD_SIZE, max_x)
    const maxY = Math.max(DEFAULT_FIELD_SIZE, max_y)
    const side = Math.max(maxX - minX, maxY - minY, DEFAULT_FIELD_SIZE)
    const margin = Math.max(side * 0.025, 16)
    return `${minX - margin} ${minY - margin} ${side + margin * 2} ${
      side + margin * 2
    }`
  }, [frameData])

  const goToFrameOffset = (offset: number) => {
    if (selectedFrameIndex < 0) return
    const nextFrame = frames[selectedFrameIndex + offset]
    if (nextFrame) {
      setSelectedFrame(nextFrame.frame)
    }
  }

  const boundsForDisplay = frameData?.bounds ?? null
  const concreteBounds: ConcretePositionBounds | null = hasBounds(boundsForDisplay)
    ? boundsForDisplay
    : null
  const selectedPositionedCount =
    frameData?.positioned_count ?? selectedSummary?.positioned_count ?? 0
  const selectedCellCount = frameData?.cell_count ?? selectedSummary?.cell_count ?? 0
  const selectedMissingCount =
    frameData?.missing_position_count ??
    Math.max(selectedCellCount - selectedPositionedCount, 0)
  const frameSliderIndex = selectedFrameIndex >= 0 ? selectedFrameIndex : 0
  const maxFrameSliderIndex = Math.max(frames.length - 1, 0)
  const lastFrameNumber = frames[frames.length - 1]?.frame ?? 0
  const isJetMode = viewMode === 'jet'
  const previewBackground = isJetMode ? JET_MIN_COLOR : 'white'

  return (
    <Box
      minH="100dvh"
      h="auto"
      bg="sand.50"
      color="ink.900"
      display="flex"
      flexDirection="column"
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
                <BreadcrumbLink href="/">
                  Dashboard
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbLink href={databasesPagePath}>
                  Databases
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbCurrentLink color="ink.900">
                  Raw Position
                </BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>

        <Stack gap="4" flex="1" minH="0">
          <Box
            display="grid"
            gridTemplateColumns={{
              base: '1fr',
              lg: 'minmax(0, 0.9fr) minmax(0, 1.1fr)',
            }}
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
              <Stack gap="3" flex="1" minH="0">
                <Stack gap="1">
                  <Text fontWeight="600">Raw Position Settings</Text>
                  <Text fontSize="sm" color="ink.700">
                    {dbName || 'Database'}
                  </Text>
                </Stack>

                <Separator borderColor="sand.200" />

                <Stack gap="2">
                  <Text fontSize="sm" color="ink.700">
                    Frame
                  </Text>
                  <HStack gap="2">
                    <Button
                      size="sm"
                      variant="outline"
                      borderColor="sand.300"
                      color="ink.700"
                      _hover={{ bg: 'sand.50' }}
                      onClick={() => goToFrameOffset(-1)}
                      disabled={!canGoPrev || isLoadingFrame}
                      minW="2.25rem"
                      px="2"
                      aria-label="Previous frame"
                    >
                      <Icon as={ArrowLeft} boxSize={4} />
                    </Button>
                    <NativeSelect.Root flex="1" minW="0">
                      <NativeSelect.Field
                        aria-label="Frame"
                        value={selectedFrame ?? ''}
                        onChange={(event) => setSelectedFrame(Number(event.target.value))}
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      >
                        {frames.map((frame) => (
                          <option key={frame.frame} value={frame.frame}>
                            Frame {frame.frame} ({frame.positioned_count}/{frame.cell_count})
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                    <Button
                      size="sm"
                      variant="outline"
                      borderColor="sand.300"
                      color="ink.700"
                      _hover={{ bg: 'sand.50' }}
                      onClick={() => goToFrameOffset(1)}
                      disabled={!canGoNext || isLoadingFrame}
                      minW="2.25rem"
                      px="2"
                      aria-label="Next frame"
                    >
                      <Icon as={ArrowRight} boxSize={4} />
                    </Button>
                  </HStack>
                </Stack>

                <Box
                  display="grid"
                  gridTemplateColumns={{ base: '1fr', md: 'repeat(2, minmax(0, 1fr))' }}
                  gap="3"
                >
                  <Stack gap="2">
                    <Text fontSize="sm" color="ink.700">
                      View mode
                    </Text>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        aria-label="View mode"
                        value={viewMode}
                        onChange={(event) =>
                          setViewMode(event.target.value as RawPositionViewMode)
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
                        <option value="jet">Jet</option>
                        <option value="contour">Contour</option>
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </Stack>

                  <Stack gap="2">
                    <Text fontSize="sm" color="ink.700">
                      Channel
                    </Text>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        aria-label="Fluorescence channel"
                        value={fluorescenceChannel}
                        onChange={(event) =>
                          setFluorescenceChannel(event.target.value as FluorescenceChannel)
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
                        <option value="fluo1">fluo1</option>
                        <option value="fluo2">fluo2</option>
                      </NativeSelect.Field>
                      <NativeSelect.Indicator color="ink.700" />
                    </NativeSelect.Root>
                  </Stack>
                </Box>

                <Box
                  bg="sand.50"
                  border="1px solid"
                  borderColor="sand.200"
                  borderRadius="md"
                  p="3"
                >
                  <Stack gap="3">
                    <HStack justify="space-between">
                      <Text fontSize="xs" color="ink.700">
                        X range
                      </Text>
                      <Text fontSize="sm" fontWeight="700">
                        {formatRange(concreteBounds, 'x')}
                      </Text>
                    </HStack>
                    <HStack justify="space-between">
                      <Text fontSize="xs" color="ink.700">
                        Y range
                      </Text>
                      <Text fontSize="sm" fontWeight="700">
                        {formatRange(concreteBounds, 'y')}
                      </Text>
                    </HStack>
                  </Stack>
                </Box>

                <HStack justify="flex-end" mt="auto">
                  <Button
                    size="sm"
                    bg="tide.500"
                    color="white"
                    _hover={{ bg: 'tide.400' }}
                    onClick={() => void fetchFrames()}
                    loading={isLoadingFrames || isLoadingFrame}
                  >
                    <Icon as={RefreshCw} boxSize={4} />
                    Reload
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
              <Stack gap="3" flex="1" minH="0">
                <Stack gap="1">
                  <Text fontWeight="600">Cell Position Preview</Text>
                </Stack>

                <Box
                  bg="sand.200"
                  borderRadius="lg"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  overflow="hidden"
                  flex="1"
                  minH={{ base: '20rem', lg: '0' }}
                >
                  {isLoadingFrames || isLoadingFrame ? (
                    <Flex align="center" justify="center" color="ink.700" fontSize="sm">
                      Loading...
                    </Flex>
                  ) : error ? (
                    <Flex align="center" justify="center" color="violet.300" fontSize="sm" px="4">
                      {error}
                    </Flex>
                  ) : !frameData || frameData.positioned_count === 0 ? (
                    <Stack align="center" justify="center" px="4" gap="1">
                      <Text fontSize="sm" fontWeight="700" color="ink.900" textAlign="center">
                        No raw positions in this frame.
                      </Text>
                      <Text fontSize="sm" color="ink.700" textAlign="center">
                        {selectedMissingCount > 0
                          ? `${formatCount(selectedMissingCount)} cells are missing position_x / position_y.`
                          : 'No cells available.'}
                      </Text>
                    </Stack>
                  ) : (
                    <Box h="full" w="full" bg={previewBackground}>
                      <svg
                        role="img"
                        aria-label={`Raw position frame ${frameData.frame}`}
                        viewBox={viewBox}
                        width="100%"
                        height="100%"
                        style={{ display: 'block', background: previewBackground }}
                        preserveAspectRatio="xMidYMid meet"
                      >
                        <rect
                          x="-100000"
                          y="-100000"
                          width="200000"
                          height="200000"
                          fill={previewBackground}
                        />
                        {isJetMode &&
                          frameData.cells.map((cell) => {
                            if (
                              !cell.jet_image ||
                              typeof cell.image_x !== 'number' ||
                              typeof cell.image_y !== 'number' ||
                              typeof cell.image_width !== 'number' ||
                              typeof cell.image_height !== 'number'
                            ) {
                              return null
                            }
                            return (
                              <image
                                key={`${cell.cell_id}-jet`}
                                href={cell.jet_image}
                                x={cell.image_x}
                                y={cell.image_y}
                                width={cell.image_width}
                                height={cell.image_height}
                                preserveAspectRatio="none"
                              />
                            )
                          })}
                        {frameData.cells.map((cell) => (
                          <polygon
                            key={cell.cell_id}
                            points={buildPolygonPoints(cell.contour)}
                            fill={isJetMode ? 'none' : 'rgba(20, 184, 166, 0.16)'}
                            stroke={isJetMode ? '#111827' : '#0f766e'}
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                      </svg>
                    </Box>
                  )}
                </Box>

                {frames.length > 1 && (
                  <Stack gap="2">
                    <HStack justify="space-between">
                      <Text fontSize="xs" color="ink.700">
                        Frame {selectedFrame ?? '-'}
                      </Text>
                      <Text fontSize="xs" color="ink.700">
                        / {lastFrameNumber}
                      </Text>
                    </HStack>
                    <Slider.Root
                      value={[frameSliderIndex]}
                      min={0}
                      max={maxFrameSliderIndex}
                      step={1}
                      disabled={frames.length <= 1 || isLoadingFrame}
                      onValueChange={(details) => {
                        const nextIndex = details.value[0]
                        if (typeof nextIndex !== 'number') return
                        const nextFrame = frames[nextIndex]
                        if (nextFrame) {
                          setSelectedFrame(nextFrame.frame)
                        }
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
    </Box>
  )
}
