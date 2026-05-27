import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

type AnnotationCell = {
  cellId: string
  label: string
  url: string
}

type SelectionOrigin = 'na' | 'label'

type ManifestEntry = {
  cell_id?: string
  label?: string
  file?: string
}

const ANNOTATION_DOWNSCALE_DEFAULT = 0.5
const ANNOTATION_DOWNSCALE_OPTIONS = [
  { value: 0.2, label: 'Fast (0.2x)' },
  { value: 0.5, label: 'Balanced (0.5x)' },
  { value: 1, label: 'Full (1.0x)' },
]
const ANNOTATION_LABEL_OPTIONS = ['1', '2', '3']

const parseManifestEntries = (payload: unknown): ManifestEntry[] => {
  if (!payload || typeof payload !== 'object') return []
  const cells = (payload as { cells?: unknown }).cells
  if (!Array.isArray(cells)) return []
  return cells.filter((entry) => entry && typeof entry === 'object') as ManifestEntry[]
}

const getSelectionOrigin = (label: string, activeLabel: string): SelectionOrigin | null => {
  const trimmed = label.trim()
  if (!trimmed) return null
  if (trimmed.toUpperCase() === 'N/A') return 'na'
  if (trimmed === activeLabel) return 'label'
  return null
}

export default function AnnotationPage() {
  const [searchParams] = useSearchParams()
  const dbName = searchParams.get('dbname') ?? ''
  const apiBase = useMemo(() => getApiBase(), [])

  const [cells, setCells] = useState<AnnotationCell[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [downscale, setDownscale] = useState(ANNOTATION_DOWNSCALE_DEFAULT)
  const [activeLabel, setActiveLabel] = useState('1')
  const [shiftPressed, setShiftPressed] = useState(false)
  const [selectedCells, setSelectedCells] = useState<Record<string, SelectionOrigin>>({})
  const [dragging, setDragging] = useState(false)
  const [dragMode, setDragMode] = useState<'select' | 'deselect'>('select')
  const activeUrlsRef = useRef<Set<string>>(new Set())
  const hoveredCellRef = useRef<{ cellId: string; label: string } | null>(null)

  useEffect(() => {
    if (!dbName) {
      setError('Database is required.')
      setCells([])
      setIsLoading(false)
      return
    }

    let isActive = true
    const controller = new AbortController()

    const loadAnnotationZip = async () => {
      setIsLoading(true)
      setError(null)
      setUpdateError(null)
      setCells([])
      setSelectedCells({})
      try {
        const params = new URLSearchParams({
          dbname: dbName,
          downscale: String(downscale),
        })
        const res = await fetch(
          `${apiBase}/get-annotation-zip?${params.toString()}`,
          { headers: { accept: 'application/zip' }, signal: controller.signal },
        )
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
        const nextCells: AnnotationCell[] = []

        for (const entry of entries) {
          const cellId = typeof entry.cell_id === 'string' ? entry.cell_id : ''
          const label = typeof entry.label === 'string' ? entry.label : ''
          const file = typeof entry.file === 'string' ? entry.file : ''
          if (!cellId || !file) continue
          const fileBytes = zip[file]
          if (!fileBytes) continue
          const blob = new Blob([fileBytes], { type: 'image/png' })
          const url = URL.createObjectURL(blob)
          nextCells.push({ cellId, label, url })
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
  }, [apiBase, dbName, downscale])

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

  const groupedCells = useMemo(() => {
    const normalized = cells.map((cell) => ({
      ...cell,
      label: cell.label.trim(),
    }))
    const na = normalized.filter((cell) => cell.label.toUpperCase() === 'N/A')
    const selectedLabelCells = normalized.filter((cell) => cell.label === activeLabel)
    return { na, selectedLabelCells }
  }, [activeLabel, cells])

  const selectedCount = useMemo(() => Object.keys(selectedCells).length, [selectedCells])

  const updateCellLabel = useCallback(
    async (cellId: string, label: string) => {
      const params = new URLSearchParams({
        dbname: dbName,
        cell_id: cellId,
        label,
      })
      const res = await fetch(`${apiBase}/update-cell-label?${params.toString()}`, {
        method: 'PATCH',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Label update failed (${res.status})`)
      }
    },
    [apiBase, dbName],
  )

  const applySelection = useCallback(() => {
    const entries = Object.entries(selectedCells)
    if (!dbName || entries.length === 0) return
    const updates = entries.map(([cellId, origin]) => ({
      cellId,
      nextLabel: origin === 'na' ? activeLabel : 'N/A',
    }))

    setCells((prev) => {
      const updateMap = new Map(updates.map((item) => [item.cellId, item.nextLabel]))
      const remaining: AnnotationCell[] = []
      const moved: AnnotationCell[] = []
      for (const cell of prev) {
        const nextLabel = updateMap.get(cell.cellId)
        if (!nextLabel) {
          remaining.push(cell)
          continue
        }
        moved.push({ ...cell, label: nextLabel })
      }
      return [...remaining, ...moved]
    })
    setSelectedCells({})
    setIsUpdating(true)
    setUpdateError(null)

    void Promise.all(updates.map((item) => updateCellLabel(item.cellId, item.nextLabel)))
      .catch((err) => {
        setUpdateError(err instanceof Error ? err.message : 'Failed to update labels')
      })
      .finally(() => {
        setIsUpdating(false)
      })
  }, [activeLabel, dbName, selectedCells, updateCellLabel])

  const applySingleLabelChange = useCallback(
    (cell: AnnotationCell) => {
      const origin = getSelectionOrigin(cell.label, activeLabel)
      if (!origin) return
      const nextLabel = origin === 'na' ? activeLabel : 'N/A'

      setCells((prev) => {
        const remaining = prev.filter((item) => item.cellId !== cell.cellId)
        const updated = prev.find((item) => item.cellId === cell.cellId)
        if (!updated) return prev
        return [...remaining, { ...updated, label: nextLabel }]
      })
      setSelectedCells((prev) => {
        if (!prev[cell.cellId]) return prev
        const next = { ...prev }
        delete next[cell.cellId]
        return next
      })
      setIsUpdating(true)
      setUpdateError(null)

      void updateCellLabel(cell.cellId, nextLabel)
        .catch((err) => {
          setUpdateError(err instanceof Error ? err.message : 'Failed to update labels')
        })
        .finally(() => {
          setIsUpdating(false)
        })
    },
    [activeLabel, updateCellLabel],
  )

  const toggleSelection = useCallback((cellId: string, origin: SelectionOrigin) => {
    setSelectedCells((prev) => {
      const next = { ...prev }
      if (next[cellId]) {
        delete next[cellId]
      } else {
        next[cellId] = origin
      }
      return next
    })
  }, [])

  const startShiftSelection = useCallback(
    (cellId: string, label: string) => {
      const origin = getSelectionOrigin(label, activeLabel)
      if (!origin) return
      const shouldSelect = !selectedCells[cellId]
      setDragMode(shouldSelect ? 'select' : 'deselect')
      setDragging(true)
      toggleSelection(cellId, origin)
    },
    [activeLabel, selectedCells, toggleSelection],
  )

  useEffect(() => {
    const downHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Shift' || event.repeat) return
      setShiftPressed(true)
      setDragging(false)
      const hovered = hoveredCellRef.current
      if (hovered) {
        startShiftSelection(hovered.cellId, hovered.label)
      }
    }
    const upHandler = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setShiftPressed(false)
        setDragging(false)
      }
    }
    window.addEventListener('keydown', downHandler)
    window.addEventListener('keyup', upHandler)
    return () => {
      window.removeEventListener('keydown', downHandler)
      window.removeEventListener('keyup', upHandler)
    }
  }, [startShiftSelection])

  const hoverSelect = useCallback(
    (cell: AnnotationCell) => {
      hoveredCellRef.current = { cellId: cell.cellId, label: cell.label }
      if (!shiftPressed) return
      const origin = getSelectionOrigin(cell.label, activeLabel)
      if (!origin) return
      if (!dragging) {
        startShiftSelection(cell.cellId, cell.label)
        return
      }
      setSelectedCells((prev) => {
        const next = { ...prev }
        if (dragMode === 'select') {
          if (!next[cell.cellId]) next[cell.cellId] = origin
        } else if (next[cell.cellId]) {
          delete next[cell.cellId]
        }
        return next
      })
    },
    [activeLabel, dragMode, dragging, shiftPressed, startShiftSelection],
  )

  const handleCellClick = useCallback(
    (cell: AnnotationCell) => {
      if (shiftPressed) {
        const origin = getSelectionOrigin(cell.label, activeLabel)
        if (!origin) return
        toggleSelection(cell.cellId, origin)
        return
      }
      void applySingleLabelChange(cell)
    },
    [activeLabel, applySingleLabelChange, shiftPressed, toggleSelection],
  )

  const gridColumns = {
    base: 'repeat(2, minmax(0, 1fr))',
    md: 'repeat(4, minmax(0, 1fr))',
    lg: 'repeat(7, minmax(0, 1fr))',
  }

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
                <BreadcrumbCurrentLink color="ink.900">Annotation</BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>
        <Stack spacing={{ base: 5, lg: 4 }} flex="1" minH="0">
          <HStack justify="space-between" flexWrap="wrap" gap="3">
            <Text fontSize="sm" color="ink.700">
              Database: {dbName || 'Not selected'}
            </Text>
            <HStack spacing="4" flexWrap="wrap" align="flex-end">
              {dbName && (
                <Button
                  size="xs"
                  variant="outline"
                  borderColor="tide.500"
                  bg="tide.500"
                  color="white"
                  _hover={{ bg: 'tide.400' }}
                  as={RouterLink}
                  to={`/bulk-engine?dbname=${encodeURIComponent(dbName)}`}
                >
                  Bulk-engine
                </Button>
              )}
              <Box minW="10rem">
                <NativeSelect.Root>
                  <NativeSelect.Field
                    value={String(downscale)}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      setDownscale(Number.isFinite(next) ? next : ANNOTATION_DOWNSCALE_DEFAULT)
                    }}
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
                    {ANNOTATION_DOWNSCALE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator color="ink.700" />
                </NativeSelect.Root>
              </Box>
              <Button
                size="xs"
                bg="tide.500"
                color="white"
                _hover={{ bg: 'tide.400' }}
                onClick={applySelection}
                isDisabled={selectedCount === 0 || isUpdating}
                opacity={selectedCount === 0 ? 0.5 : 1}
                cursor={selectedCount === 0 ? 'not-allowed' : 'pointer'}
              >
                Apply ({selectedCount})
              </Button>
            </HStack>
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

          {!isLoading && !error && updateError && (
            <Text fontSize="sm" color="violet.300">
              {updateError}
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
                <HStack justify="space-between" align="center" mb="3">
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
                      N/A
                    </Badge>
                    <Text fontSize="xs" color="ink.700">
                      Unlabeled
                    </Text>
                  </HStack>
                  <Text fontSize="xs" color="ink.700">
                    {groupedCells.na.length} cells
                  </Text>
                </HStack>
                <Box
                  flex="1"
                  minH="0"
                  overflowY={{ base: 'visible', lg: 'auto' }}
                  maxH="100%"
                  pr={{ base: 0, lg: 1 }}
                >
                  <Grid templateColumns={gridColumns} gap="2" pb="1">
                    {groupedCells.na.map((cell) => (
                      <Box
                        key={`na-${cell.cellId}`}
                        bg="sand.50"
                        borderRadius="md"
                        p="1"
                        borderWidth={selectedCells[cell.cellId] ? '3px' : '1px'}
                        borderColor={selectedCells[cell.cellId] ? 'tide.500' : 'sand.200'}
                        cursor="pointer"
                        onClick={() => handleCellClick(cell)}
                        onMouseEnter={() => hoverSelect(cell)}
                        onMouseLeave={() => {
                          hoveredCellRef.current = null
                        }}
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
                </Box>
              </Box>

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
                <HStack justify="space-between" align="center" mb="3">
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
                      Label {activeLabel}
                    </Badge>
                    <Box minW="4.5rem">
                      <NativeSelect.Root>
                        <NativeSelect.Field
                          value={activeLabel}
                          onChange={(event) => {
                            setActiveLabel(event.target.value || '1')
                          }}
                          bg="sand.50"
                          border="1px solid"
                          borderColor="sand.200"
                          fontSize="xs"
                          h="1.75rem"
                          color="ink.900"
                          _focusVisible={{
                            borderColor: 'tide.400',
                            boxShadow: '0 0 0 1px var(--app-accent-ring)',
                          }}
                        >
                          {ANNOTATION_LABEL_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator color="ink.700" />
                      </NativeSelect.Root>
                    </Box>
                    <Text fontSize="xs" color="ink.700">
                      Positive
                    </Text>
                  </HStack>
                  <Text fontSize="xs" color="ink.700">
                    {groupedCells.selectedLabelCells.length} cells
                  </Text>
                </HStack>
                <Box
                  flex="1"
                  minH="0"
                  overflowY={{ base: 'visible', lg: 'auto' }}
                  maxH="100%"
                  pr={{ base: 0, lg: 1 }}
                >
                  <Grid templateColumns={gridColumns} gap="2" pb="1">
                    {groupedCells.selectedLabelCells.map((cell) => (
                      <Box
                        key={`label-${activeLabel}-${cell.cellId}`}
                        bg="sand.50"
                        borderRadius="md"
                        p="1"
                        borderWidth={selectedCells[cell.cellId] ? '3px' : '1px'}
                        borderColor={selectedCells[cell.cellId] ? 'tide.500' : 'sand.200'}
                        cursor="pointer"
                        onClick={() => handleCellClick(cell)}
                        onMouseEnter={() => hoverSelect(cell)}
                        onMouseLeave={() => {
                          hoveredCellRef.current = null
                        }}
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
                </Box>
              </Box>
            </Grid>
          )}
        </Stack>
      </Container>
    </Box>
  )
}
