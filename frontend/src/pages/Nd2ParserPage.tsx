import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
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
  Grid,
  Heading,
  HStack,
  IconButton,
  Input,
  Checkbox,
  NativeSelect,
  SimpleGrid,
  Stack,
  Text,
  AspectRatio,
  Spinner,
} from '@chakra-ui/react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Move,
  Crop as CropIcon,
} from 'lucide-react'

// --- 連続入力のためのカスタムフック ---
function useContinuousHold(callback: () => void, interval = 7, delay = 27) {
  const [isHolding, setIsHolding] = useState(false)
  const timerRef = useRef<number | null>(null)
  const intervalRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (intervalRef.current) clearInterval(intervalRef.current)
    setIsHolding(false)
  }, [])

  const start = useCallback(() => {
    stop() // Reset any existing timers
    setIsHolding(true)
    callback() // 初回実行

    // delay ms後に連続実行開始
    timerRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => {
        callback()
      }, interval)
    }, delay)
  }, [callback, delay, interval, stop])

  // コンポーネントのアンマウント時や依存変更時にクリーンアップ
  useEffect(() => {
    return stop
  }, [stop])

  return {
    onMouseDown: start,
    onMouseUp: stop,
    onMouseLeave: stop,
    onTouchStart: start,
    onTouchEnd: stop,
  }
}

// --- 十字キーボタンのコンポーネント ---
const DPadButton = ({
  icon,
  onClick,
  isDisabled,
  ...props
}: {
  icon: React.ReactNode
  onClick: () => void
  isDisabled?: boolean
  [key: string]: any
}) => {
  const holdHandlers = useContinuousHold(onClick)
  
  return (
    <IconButton
      size="xs"
      variant="outline"
      bg="white"
      borderColor="sand.200"
      color="gray.900"
      borderRadius="md"
      w="2rem"
      h="2rem"
      minW="2rem"
      _hover={{ bg: 'white', borderColor: 'sand.300' }}
      _active={{ bg: 'white', transform: 'scale(0.96)' }}
      isDisabled={isDisabled}
      {...holdHandlers} // マウス・タッチイベントを展開
      {...props}
    >
      {icon}
    </IconButton>
  )
}

type ChannelKey = 'ph' | 'fluo1' | 'fluo2'

type MetadataResponse = {
  nd2file?: string
  nd2_stem?: string
  channels?: string[]
  frames?: number
  width?: number | null
  height?: number | null
  detected_channels?: number | null
}

const channelOrder: ChannelKey[] = ['ph', 'fluo1', 'fluo2']
const channelLabels: Record<ChannelKey, string> = {
  ph: 'PH',
  fluo1: 'Fluo1',
  fluo2: 'Fluo2',
}

export default function Nd2ParserPage() {
  const [searchParams] = useSearchParams()
  const apiBase = useMemo(() => getApiBase(), [])
  const nd2file = (searchParams.get('nd2file') ?? '').trim()
  const [metadata, setMetadata] = useState<MetadataResponse | null>(null)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [functionMode, setFunctionMode] = useState<
    'none' | 'optical-boost' | 'crop'
  >('crop')
  const [gridSize, setGridSize] = useState(500)
  const [gridSizeInput, setGridSizeInput] = useState('500')
  const [center, setCenter] = useState({ x: 790, y: 705 })
  const [exportOpticalBoost, setExportOpticalBoost] = useState(false)
  const [exportBrightness, setExportBrightness] = useState(1)
  const [exportBrightnessInput, setExportBrightnessInput] = useState('1')
  const [isExporting, setIsExporting] = useState(false)
  const [images, setImages] = useState<Record<ChannelKey, string | null>>({
    ph: null,
    fluo1: null,
    fluo2: null,
  })
  const [missingChannels, setMissingChannels] = useState<
    Record<ChannelKey, boolean>
  >({
    ph: false,
    fluo1: false,
    fluo2: false,
  })
  const [isLoadingMeta, setIsLoadingMeta] = useState(false)
  const [isParsing, setIsParsing] = useState(false)
  const [isLoadingImages, setIsLoadingImages] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewerSize, setViewerSize] = useState({ width: 0, height: 0 })
  const firstChannelRef = useRef<HTMLDivElement | null>(null)
  const lastFileRef = useRef<string | null>(null)

  const existingChannels = useMemo(() => {
    if (!metadata?.channels) return []
    return channelOrder.filter((channel) => metadata.channels?.includes(channel))
  }, [metadata?.channels])

  const frameCount = Number.isFinite(metadata?.frames)
    ? Number(metadata?.frames)
    : 0
  const imageMode = useMemo(() => {
    if (functionMode === 'optical-boost') return 'optical-boost'
    if (functionMode === 'crop' && exportOpticalBoost) return 'optical-boost'
    return 'none'
  }, [exportOpticalBoost, functionMode])
  const imageBrightness = useMemo(() => {
    if (functionMode === 'crop') return exportBrightness
    return 1
  }, [exportBrightness, functionMode])

  const clampGridAndCenter = useCallback(
    (size: number, nextCenter: { x: number; y: number }) => {
      if (!metadata?.width || !metadata?.height) {
        return { size, center: nextCenter }
      }
      const maxSize = Math.max(
        1,
        Math.min(Math.floor(size), metadata.width, metadata.height),
      )
      const half = Math.floor(maxSize / 2)
      const maxX = Math.max(half, metadata.width - (maxSize - half))
      const maxY = Math.max(half, metadata.height - (maxSize - half))
      const clamped = {
        x: Math.min(Math.max(nextCenter.x, half), maxX),
        y: Math.min(Math.max(nextCenter.y, half), maxY),
      }
      return { size: maxSize, center: clamped }
    },
    [metadata?.height, metadata?.width],
  )

  const overlayStyle = useMemo(() => {
    if (
      functionMode !== 'crop' ||
      !metadata?.width ||
      !metadata?.height ||
      viewerSize.width <= 0 ||
      viewerSize.height <= 0 ||
      gridSize <= 0
    ) {
      return null
    }
    const safeGrid = Math.min(gridSize, metadata.width, metadata.height)
    const scale = Math.min(
      viewerSize.width / metadata.width,
      viewerSize.height / metadata.height,
    )
    const displayWidth = metadata.width * scale
    const displayHeight = metadata.height * scale
    const offsetX = (viewerSize.width - displayWidth) / 2
    const offsetY = (viewerSize.height - displayHeight) / 2
    const left = offsetX + (center.x - safeGrid / 2) * scale
    const top = offsetY + (center.y - safeGrid / 2) * scale
    return {
      left,
      top,
      size: safeGrid * scale,
    }
  }, [
    center.x,
    center.y,
    functionMode,
    gridSize,
    metadata?.height,
    metadata?.width,
    viewerSize.height,
    viewerSize.width,
  ])

  const handlePreviousFrame = useCallback(() => {
    setCurrentFrame((prev) => Math.max(prev - 1, 0))
  }, [])

  const handleNextFrame = useCallback(() => {
    setCurrentFrame((prev) => Math.min(prev + 1, Math.max(frameCount - 1, 0)))
  }, [frameCount])

  const handleMoveCenter = useCallback(
    (dx: number, dy: number) => {
      setCenter((prev) => {
        const next = { x: prev.x + dx, y: prev.y + dy }
        return clampGridAndCenter(gridSize, next).center
      })
    },
    [clampGridAndCenter, gridSize],
  )

  const handleExportRegion = useCallback(async () => {
    if (!nd2file || isExporting || frameCount <= 0) return
    const { size, center: safeCenter } = clampGridAndCenter(gridSize, center)
    if (!metadata?.width || !metadata?.height) return
    setIsExporting(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        nd2file,
        frame: String(currentFrame),
        grid_size: String(size),
        center_x: String(safeCenter.x),
        center_y: String(safeCenter.y),
        mode: exportOpticalBoost ? 'optical-boost' : 'none',
        brightness: String(exportBrightness),
      })
      const res = await fetch(
        `${apiBase}/nd2parser/export-region?${params.toString()}`,
        {
          headers: { accept: 'image/png' },
        },
      )
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      const fileStem = nd2file.replace(/\\.nd2$/i, '') || 'nd2file'
      anchor.href = url
      anchor.download = `${fileStem}_frame${currentFrame}_crop.png`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export region')
    } finally {
      setIsExporting(false)
    }
  }, [
    apiBase,
    center,
    clampGridAndCenter,
    currentFrame,
    frameCount,
    exportBrightness,
    exportOpticalBoost,
    gridSize,
    isExporting,
    metadata?.height,
    metadata?.width,
    nd2file,
  ])

  const fetchMetadata = useCallback(async () => {
    if (!nd2file) {
      setMetadata(null)
      setError('ND2 file is not specified.')
      return
    }
    setIsLoadingMeta(true)
    setError(null)
    try {
      const res = await fetch(
        `${apiBase}/nd2parser/metadata?nd2file=${encodeURIComponent(nd2file)}`,
        { headers: { accept: 'application/json' } },
      )
      if (!res.ok) {
        if (res.status === 404) {
          setMetadata(null)
          setError('Parsed data not found. Run Parse ND2 first.')
          return
        }
        throw new Error(`Request failed (${res.status})`)
      }
      const data = (await res.json()) as MetadataResponse
      setMetadata(data)
    } catch (err) {
      setMetadata(null)
      setError(err instanceof Error ? err.message : 'Failed to load metadata')
    } finally {
      setIsLoadingMeta(false)
    }
  }, [apiBase, nd2file])

  const handleParse = useCallback(async () => {
    if (!nd2file || isParsing) return
    setIsParsing(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/nd2parser/parse`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nd2file }),
      })
      if (!res.ok) {
        throw new Error(`Parse failed (${res.status})`)
      }
      const data = (await res.json()) as MetadataResponse
      setMetadata(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse ND2 file')
    } finally {
      setIsParsing(false)
    }
  }, [apiBase, isParsing, nd2file])

  useEffect(() => {
    void fetchMetadata()
  }, [fetchMetadata])

  useEffect(() => {
    setCurrentFrame((prev) => {
      if (frameCount <= 0) return 0
      return Math.min(prev, Math.max(frameCount - 1, 0))
    })
  }, [frameCount])

  useEffect(() => {
    if (!metadata?.width || !metadata?.height || !nd2file) return
    if (lastFileRef.current !== nd2file) {
      lastFileRef.current = nd2file
      const defaultSize = Math.min(500, metadata.width, metadata.height)
      setGridSize(defaultSize)
      setGridSizeInput(String(defaultSize))
      setCenter({ x: 790, y: 705 })
    }
  }, [metadata?.height, metadata?.width, nd2file])

  useEffect(() => {
    if (!metadata?.width || !metadata?.height) return
    const { size, center: clamped } = clampGridAndCenter(gridSize, center)
    if (size !== gridSize) setGridSize(size)
    if (clamped.x !== center.x || clamped.y !== center.y) setCenter(clamped)
  }, [center, clampGridAndCenter, gridSize, metadata?.height, metadata?.width])

  useEffect(() => {
    setGridSizeInput(String(gridSize))
  }, [gridSize])

  useEffect(() => {
    if (!nd2file || !metadata || frameCount <= 0) {
      setImages({ ph: null, fluo1: null, fluo2: null })
      setMissingChannels({ ph: false, fluo1: false, fluo2: false })
      return
    }

    let isActive = true
    const fetchChannel = async (
      channel: ChannelKey,
    ): Promise<{ url: string | null; missing: boolean }> => {
      const params = new URLSearchParams({
        nd2file,
        channel,
        frame: String(currentFrame),
        mode: imageMode,
        brightness: String(imageBrightness),
      })
      const res = await fetch(
        `${apiBase}/nd2parser/image?${params.toString()}`,
        { headers: { accept: 'image/png' } },
      )
      if (!res.ok) {
        return { url: null, missing: res.status === 404 }
      }
      const blob = await res.blob()
      return { url: URL.createObjectURL(blob), missing: false }
    }

    const loadImages = async () => {
      setIsLoadingImages(true)
      setError(null)
      setImages({ ph: null, fluo1: null, fluo2: null })
      setMissingChannels({ ph: false, fluo1: false, fluo2: false })
      try {
        const results = await Promise.all(
          existingChannels.map((channel) => fetchChannel(channel)),
        )
        if (!isActive) {
          results.forEach((result) => {
            if (result.url) URL.revokeObjectURL(result.url)
          })
          return
        }
        const nextImages: Record<ChannelKey, string | null> = {
          ph: null,
          fluo1: null,
          fluo2: null,
        }
        const nextMissing: Record<ChannelKey, boolean> = {
          ph: false,
          fluo1: false,
          fluo2: false,
        }
        channelOrder.forEach((channel) => {
          if (metadata.channels && !metadata.channels.includes(channel)) {
            nextMissing[channel] = true
          }
        })
        existingChannels.forEach((channel, index) => {
          nextImages[channel] = results[index].url
          nextMissing[channel] = results[index].missing
        })
        setImages(nextImages)
        setMissingChannels(nextMissing)
      } catch (err) {
        if (isActive) {
          setError(err instanceof Error ? err.message : 'Failed to load images')
          setImages({ ph: null, fluo1: null, fluo2: null })
          setMissingChannels({ ph: false, fluo1: false, fluo2: false })
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
    existingChannels,
    currentFrame,
    frameCount,
    imageBrightness,
    imageMode,
    metadata,
    nd2file,
  ])

  useEffect(() => {
    return () => {
      Object.values(images).forEach((url) => {
        if (url) URL.revokeObjectURL(url)
      })
    }
  }, [images])

  useEffect(() => {
    const node = firstChannelRef.current
    if (!node) return
    const updateSize = () => {
      const rect = node.getBoundingClientRect()
      setViewerSize({ width: rect.width, height: rect.height })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [existingChannels.length])

  return (
    <Box
      minH="100dvh"
      h="auto"
      bg="sand.50"
      color="ink.900"
      display="flex"
      flexDirection="column"
      overflow="visible"
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
                <BreadcrumbCurrentLink color="ink.900">
                  ND2 Parser
                </BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>
        <Stack spacing="4" flex="1" minH="0">
          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            px="4"
            py="3"
            flexShrink={0}
          >
            <Flex
              direction={{ base: 'column', lg: 'row' }}
              align={{ base: 'flex-start', lg: 'flex-end' }}
              gap="4"
              flexWrap="wrap"
            >
              <Box minW="10rem">
                <Stack spacing="1">
                  <Text fontSize="xs" color="ink.700">
                    Mode
                  </Text>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      value={functionMode}
                      onChange={(event) =>
                        setFunctionMode(
                          event.target.value as
                            | 'none'
                            | 'optical-boost'
                            | 'crop',
                        )
                      }
                      bg="sand.50"
                      border="1px solid"
                      borderColor="sand.200"
                      fontSize="sm"
                      h={{ base: '2.25rem', lg: '2rem' }}
                      color="ink.900"
                      _focusVisible={{
                        borderColor: 'tide.400',
                        boxShadow: '0 0 0 1px var(--app-accent-ring)',
                      }}
                    >
                      <option value="none">None</option>
                      <option value="optical-boost">Optical boost</option>
                      <option value="crop">Crop</option>
                    </NativeSelect.Field>
                    <NativeSelect.Indicator color="ink.700" />
                  </NativeSelect.Root>
                </Stack>
              </Box>

              {!metadata && (
                <Button
                  size="sm"
                  bg="tide.500"
                  color="white"
                  _hover={{ bg: 'tide.400' }}
                  onClick={handleParse}
                  loading={isParsing}
                  isDisabled={!nd2file}
                  alignSelf="flex-end"
                >
                  Parse ND2
                </Button>
              )}

              {functionMode === 'crop' && (
                <>
                  <Box
                    w="1px"
                    h="2.5rem"
                    bg="sand.300"
                    display={{ base: 'none', lg: 'block' }}
                    mx="2"
                  />
                  
                  {/* Grid Size Input */}
                  <Box minW="6rem">
                    <Stack spacing="1">
                      <Text fontSize="xs" color="ink.700">
                        Size (px)
                      </Text>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={gridSizeInput}
                        onChange={(event) => {
                          const nextValue = event.target.value
                          setGridSizeInput(nextValue)
                          if (nextValue.trim() === '') return
                          const next = Number(nextValue)
                          if (Number.isNaN(next)) return
                          setGridSize(Math.max(1, next))
                        }}
                        onBlur={() => {
                          if (gridSizeInput.trim() === '') {
                            setGridSizeInput(String(gridSize))
                            return
                          }
                          const next = Number(gridSizeInput)
                          if (Number.isNaN(next)) {
                            setGridSizeInput(String(gridSize))
                            return
                          }
                          const normalized = Math.max(1, Math.round(next))
                          setGridSize(normalized)
                          setGridSizeInput(String(normalized))
                        }}
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        fontSize="sm"
                        h={{ base: '2.25rem', lg: '2rem' }}
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                      />
                    </Stack>
                  </Box>

                  {/* Position Info */}
                  <Box minW="6rem" mr="2">
                    <Stack spacing="1">
                      <Text fontSize="xs" color="ink.700">
                        Center (x, y)
                      </Text>
                      <Flex
                        bg="sand.50"
                        border="1px solid"
                        borderColor="sand.200"
                        h={{ base: '2.25rem', lg: '2rem' }}
                        align="center"
                        px="3"
                        borderRadius="md"
                      >
                         <Text fontSize="sm" fontWeight="600" color="ink.900">
                          {center.x}, {center.y}
                        </Text>
                      </Flex>
                    </Stack>
                  </Box>

                  {/* Export options */}
                  <Box minW="10rem">
                    <Stack spacing="2">
                      <Text fontSize="xs" color="ink.700">
                        Export options
                      </Text>
                      <HStack spacing="4" align="center" flexWrap="nowrap">
                        <Checkbox.Root
                          checked={exportOpticalBoost}
                          onCheckedChange={(details) =>
                            setExportOpticalBoost(details.checked === true)
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
                          <Checkbox.Label fontSize="sm" color="ink.700">
                            Optical boost
                          </Checkbox.Label>
                        </Checkbox.Root>
                        <HStack spacing="2" align="center">
                          <Text fontSize="xs" color="ink.700" whiteSpace="nowrap">
                            Brightness (x)
                          </Text>
                          <Input
                            type="number"
                            min={0.01}
                            step={0.1}
                            value={exportBrightnessInput}
                            onChange={(event) => {
                              const nextValue = event.target.value
                              setExportBrightnessInput(nextValue)
                              if (nextValue.trim() === '') return
                              const next = Number(nextValue)
                              if (!Number.isFinite(next) || next <= 0) return
                              setExportBrightness(next)
                            }}
                            onBlur={() => {
                              const trimmed = exportBrightnessInput.trim()
                              if (trimmed === '') {
                                setExportBrightnessInput(String(exportBrightness))
                                return
                              }
                              const next = Number(trimmed)
                              if (!Number.isFinite(next) || next <= 0) {
                                setExportBrightnessInput(String(exportBrightness))
                                return
                              }
                              const normalized = Math.max(0.01, next)
                              setExportBrightness(normalized)
                              setExportBrightnessInput(String(normalized))
                            }}
                            maxW="5.5rem"
                            bg="sand.50"
                            border="1px solid"
                            borderColor="sand.200"
                            fontSize="sm"
                            h={{ base: '2.25rem', lg: '2rem' }}
                            color="ink.900"
                            _focusVisible={{
                              borderColor: 'tide.400',
                              boxShadow: '0 0 0 1px var(--app-accent-ring)',
                            }}
                          />
                        </HStack>
                      </HStack>
                    </Stack>
                  </Box>

                  <Button
                    size="sm"
                    bg="tide.500"
                    color="white"
                    _hover={{ bg: 'tide.400' }}
                    onClick={handleExportRegion}
                    loading={isExporting}
                    isDisabled={!metadata || frameCount <= 0}
                    leftIcon={<CropIcon size={16} />}
                    ml={{ lg: 'auto' }} 
                  >
                    Export
                  </Button>
                </>
              )}

              {isLoadingMeta && (
                <Text fontSize="sm" color="ink.700" alignSelf="center">
                  Loading...
                </Text>
              )}
            </Flex>
            {error && (
                <Text fontSize="sm" color="violet.300" mt="2">
                  {error}
                </Text>
              )}
          </Box>

          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            px="4"
            py="3"
            flex="1"
            minH="0"
            overflow="hidden"
            display="flex"
            flexDirection="column"
          >
            {/* ... (画像の表示エリアは変更なし) ... */}
            <Stack spacing="3" flex="1" minH="0">
              {frameCount === 0 && (
                <Flex align="center" justify="center" py="8" color="ink.700">
                  {nd2file ? 'No frames available.' : 'Select an ND2 file first.'}
                </Flex>
              )}

              {frameCount > 0 && (
                <Grid
                  templateColumns={{ base: '1fr', md: 'minmax(0, 1fr) 14rem' }}
                  gap="3"
                  flex="1"
                  minH="0"
                  alignItems="stretch"
                >
                  <SimpleGrid
                    columns={{ base: 3, md: 3 }}
                    spacing="3"
                    minH="0"
                    alignContent="start"
                  >
                    {channelOrder.map((channel, index) => {
                      const channelMissing =
                        metadata?.channels?.includes(channel) === false
                      return (
                        <Box
                          key={channel}
                          borderRadius="lg"
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          p="3"
                          display="flex"
                          flexDirection="column"
                          minH="0"
                        >
                          <Text
                            fontSize="xs"
                            letterSpacing="0.18em"
                            color="ink.700"
                            mb="2"
                          >
                            {channelLabels[channel]}
                          </Text>
                          <AspectRatio ratio={1} w="100%">
                            <Box
                              bg="sand.200"
                              borderRadius="md"
                              overflow="hidden"
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                              position="relative"
                              ref={index === 0 ? firstChannelRef : undefined}
                            >
                              {isLoadingImages ? (
                                <Spinner color="ink.700" />
                              ) : images[channel] ? (
                                <Box
                                  as="img"
                                  src={images[channel] ?? undefined}
                                  alt={`${channelLabels[channel]} frame ${currentFrame}`}
                                  width="100%"
                                  height="100%"
                                  objectFit="contain"
                                />
                              ) : (
                                <Text fontSize="sm" color="ink.700">
                                  {channelMissing || missingChannels[channel]
                                    ? 'channel does not exist'
                                    : 'Image not available.'}
                                </Text>
                              )}
                              {functionMode === 'crop' && overlayStyle && (
                                <Box
                                  position="absolute"
                                  left={`${overlayStyle.left}px`}
                                  top={`${overlayStyle.top}px`}
                                  width={`${overlayStyle.size}px`}
                                  height={`${overlayStyle.size}px`}
                                  border="2px solid"
                                  borderColor="red.400"
                                  pointerEvents="none"
                                />
                              )}
                            </Box>
                          </AspectRatio>
                        </Box>
                      )
                    })}
                  </SimpleGrid>
                  <Stack spacing="3" minW="10rem" flexShrink={0}>
                    <Box>
                      <Text
                        fontSize="sm"
                        fontWeight="600"
                        color="ink.900"
                        mb="1"
                      >
                        Frame Viewer
                      </Text>
                      <Text fontSize="sm" color="ink.700">
                        Frame {currentFrame} / {Math.max(frameCount - 1, 0)}
                      </Text>
                    </Box>
                    <HStack spacing="2" flexWrap="wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        borderColor="tide.500"
                        bg="tide.500"
                        color="white"
                        _hover={{ bg: 'tide.400' }}
                        onClick={handlePreviousFrame}
                        isDisabled={currentFrame <= 0 || isLoadingImages}
                      >
                        Previous
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        borderColor="tide.500"
                        bg="tide.500"
                        color="white"
                        _hover={{ bg: 'tide.400' }}
                        onClick={handleNextFrame}
                        isDisabled={
                          currentFrame >= Math.max(frameCount - 1, 0) ||
                          isLoadingImages
                        }
                      >
                        Next
                      </Button>
                    </HStack>
                    {functionMode === 'crop' && (
                      <Box>
                        <Text fontSize="xs" color="ink.700" mb="2">
                          Move
                        </Text>
                        <Box
                          bg="sand.100"
                          border="1px solid"
                          borderColor="sand.200"
                          borderRadius="md"
                          p="1"
                        >
                          <Grid
                            templateAreas={`
                              ". U ."
                              "L C R"
                              ". D ."
                            `}
                            templateColumns="2rem 2rem 2rem"
                            templateRows="2rem 2rem 2rem"
                            gap="2px"
                          >
                            <DPadButton
                              gridArea="U"
                              aria-label="Move up"
                              icon={<ArrowUp size={16} />}
                              onClick={() => handleMoveCenter(0, -1)}
                              isDisabled={!metadata}
                            />
                            <DPadButton
                              gridArea="L"
                              aria-label="Move left"
                              icon={<ArrowLeft size={16} />}
                              onClick={() => handleMoveCenter(-1, 0)}
                              isDisabled={!metadata}
                            />
                            <Flex
                              gridArea="C"
                              align="center"
                              justify="center"
                              color="ink.700"
                              bg="sand.100"
                              border="1px solid"
                              borderColor="sand.200"
                              borderRadius="md"
                              w="2rem"
                              h="2rem"
                            >
                              <Move size={14} />
                            </Flex>
                            <DPadButton
                              gridArea="R"
                              aria-label="Move right"
                              icon={<ArrowRight size={16} />}
                              onClick={() => handleMoveCenter(1, 0)}
                              isDisabled={!metadata}
                            />
                            <DPadButton
                              gridArea="D"
                              aria-label="Move down"
                              icon={<ArrowDown size={16} />}
                              onClick={() => handleMoveCenter(0, 1)}
                              isDisabled={!metadata}
                            />
                          </Grid>
                        </Box>
                      </Box>
                    )}
                  </Stack>
                </Grid>
              )}
            </Stack>
          </Box>
        </Stack>
      </Container>
    </Box>
  )
}
