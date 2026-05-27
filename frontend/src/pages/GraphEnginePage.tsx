import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import {
  AspectRatio,
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
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type ResultItem = {
  filename: string
  mean_length?: number
  nagg_rate?: number
}

type HeatmapUrls = {
  abs?: string
  rel?: string
  dist?: string
  dist_box?: string
}

type GraphModeOption = {
  value: string
  label: string
}

const GRAPH_MODE_OPTIONS: GraphModeOption[] = [
  { value: 'HU_aggregation_ratio', label: 'HU aggregation ratio' },
]

const TABLE_COLUMNS =
  'minmax(0, 1.4fr) 9rem 8rem 8rem 8rem 8rem 8rem'

const parseResults = (payload: unknown): ResultItem[] => {
  if (Array.isArray(payload)) {
    return payload
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const entry = item as ResultItem
        return {
          filename: typeof entry.filename === 'string' ? entry.filename : '',
          mean_length: typeof entry.mean_length === 'number' ? entry.mean_length : undefined,
          nagg_rate: typeof entry.nagg_rate === 'number' ? entry.nagg_rate : undefined,
        }
      })
      .filter((item) => item.filename)
  }

  if (payload && typeof payload === 'object') {
    const maybeResults = (payload as { results?: unknown }).results
    if (Array.isArray(maybeResults)) {
      return parseResults(maybeResults)
    }
  }

  return []
}

const formatNumber = (value?: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '-'

const formatPercent = (value?: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(2)}%`
    : '-'

const revokeHeatmapUrls = (map: Record<string, HeatmapUrls>) => {
  Object.values(map).forEach((entry) => {
    Object.values(entry).forEach((url) => {
      if (url) {
        URL.revokeObjectURL(url)
      }
    })
  })
}

export default function GraphEnginePage() {
  const apiBase = useMemo(() => getApiBase(), [])
  const [graphMode, setGraphMode] = useState(GRAPH_MODE_OPTIONS[0].value)
  const [ctrlFile, setCtrlFile] = useState<File | null>(null)
  const [files, setFiles] = useState<File[] | null>(null)
  const [results, setResults] = useState<ResultItem[]>([])
  const [heatmaps, setHeatmaps] = useState<Record<string, HeatmapUrls>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ctrlInputRef = useRef<HTMLInputElement | null>(null)
  const filesInputRef = useRef<HTMLInputElement | null>(null)
  const heatmapsRef = useRef<Record<string, HeatmapUrls>>({})
  const runIdRef = useRef(0)

  const replaceHeatmaps = useCallback((next: Record<string, HeatmapUrls>) => {
    revokeHeatmapUrls(heatmapsRef.current)
    heatmapsRef.current = next
    setHeatmaps(next)
  }, [])

  useEffect(() => () => revokeHeatmapUrls(heatmapsRef.current), [])

  const handleCtrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setCtrlFile(file)
    event.target.value = ''
  }

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFiles = event.target.files
    const selected = nextFiles ? Array.from(nextFiles) : []
    setFiles(selected.length > 0 ? selected : null)
    event.target.value = ''
  }

  const handleAnalyze = useCallback(async () => {
    if (!files?.length) {
      setError('Please select one or more CSV files.')
      return
    }

    const selectedFiles = files
    const runId = runIdRef.current + 1
    runIdRef.current = runId

    setIsLoading(true)
    setError(null)
    setResults([])
    replaceHeatmaps({})

    try {
      const formData = new FormData()
      if (ctrlFile) {
        formData.append('ctrl_file', ctrlFile)
      }
      selectedFiles.forEach((file) => formData.append('files', file))

      const res = await fetch(
        `${apiBase}/graph_engine/${encodeURIComponent(graphMode)}`,
        {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: formData,
        },
      )

      if (!res.ok) {
        throw new Error(`Analyze failed (${res.status})`)
      }

      const payload = await res.json()
      if (runIdRef.current !== runId) {
        return
      }

      const nextResults = parseResults(payload)
      setResults(nextResults)

      const createImage = async (endpoint: string, file: File) => {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('mode', graphMode)
        const imageRes = await fetch(endpoint, {
          method: 'POST',
          body: fd,
        })
        if (!imageRes.ok) {
          throw new Error(`Image request failed (${imageRes.status})`)
        }
        const blob = await imageRes.blob()
        const url = URL.createObjectURL(blob)
        if (runIdRef.current !== runId) {
          URL.revokeObjectURL(url)
          return null
        }
        return url
      }

      const heatmapPromises = selectedFiles.map(async (file) => {
        const [abs, rel, dist, distBox] = await Promise.all([
          createImage(`${apiBase}/graph_engine/heatmap_abs`, file),
          createImage(`${apiBase}/graph_engine/heatmap_rel`, file),
          createImage(`${apiBase}/graph_engine/distribution`, file),
          createImage(`${apiBase}/graph_engine/distribution_box`, file),
        ])

        if (!abs && !rel && !dist && !distBox) {
          return null
        }

        return [
          file.name,
          {
            abs: abs ?? undefined,
            rel: rel ?? undefined,
            dist: dist ?? undefined,
            dist_box: distBox ?? undefined,
          },
        ] as const
      })

      const heatmapEntries = await Promise.allSettled(heatmapPromises)
      if (runIdRef.current !== runId) {
        return
      }

      const nextHeatmaps: Record<string, HeatmapUrls> = {}
      heatmapEntries.forEach((entry) => {
        if (entry.status === 'fulfilled' && entry.value) {
          const [name, urls] = entry.value
          nextHeatmaps[name] = urls
        }
      })

      replaceHeatmaps(nextHeatmaps)
    } catch (err) {
      if (runIdRef.current !== runId) {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to analyze files')
    } finally {
      if (runIdRef.current === runId) {
        setIsLoading(false)
      }
    }
  }, [apiBase, ctrlFile, files, graphMode, replaceHeatmaps])

  const rows = useMemo(() => {
    if (files?.length) {
      return files.map((file) => file.name)
    }
    return results.map((result) => result.filename)
  }, [files, results])

  const resultsByName = useMemo(() => {
    return new Map(results.map((result) => [result.filename, result]))
  }, [results])

  return (
    <Box minH="100vh" bg="sand.50" color="ink.900">
      <PageHeader
        actions={
          <>
            <ReloadButton />
            <ThemeToggleButton />
          </>
        }
      />

      <Container maxW="72.5rem" py={{ base: 8, md: 12 }}>
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
                  Graph Engine
                </BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>
        <Stack spacing="6">
          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            p={{ base: 4, md: 5 }}
          >
            <Stack spacing="4">
              <Stack spacing="1">
                <Heading size="md">Graph Engine</Heading>
                <Text fontSize="sm" color="ink.700">
                  Select a graph mode and upload CSV files to generate summary metrics and plots.
                </Text>
              </Stack>

              <Box
                display="grid"
                gridTemplateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }}
                gap="3"
              >
                <Stack spacing="2">
                  <Text fontSize="sm" color="ink.700">
                    Graph mode
                  </Text>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      value={graphMode}
                      onChange={(event) => setGraphMode(event.target.value)}
                      bg="sand.50"
                      border="1px solid"
                      borderColor="sand.200"
                      color="ink.900"
                      _focusVisible={{
                        borderColor: 'tide.400',
                        boxShadow: '0 0 0 1px var(--app-accent-ring)',
                      }}
                    >
                      {GRAPH_MODE_OPTIONS.map((option) => (
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
                    Control CSV (optional)
                  </Text>
                  <Button
                    size="sm"
                    variant="outline"
                    borderColor="sand.200"
                    bg="sand.50"
                    color="ink.900"
                    _hover={{ bg: 'sand.100' }}
                    onClick={() => ctrlInputRef.current?.click()}
                    isDisabled={isLoading}
                    justifyContent="flex-start"
                    textAlign="left"
                    overflow="hidden"
                  >
                    {ctrlFile ? ctrlFile.name : 'Select control CSV'}
                  </Button>
                </Stack>

                <Stack spacing="2">
                  <Text fontSize="sm" color="ink.700">
                    CSV files
                  </Text>
                  <Button
                    size="sm"
                    variant="outline"
                    borderColor="sand.200"
                    bg="sand.50"
                    color="ink.900"
                    _hover={{ bg: 'sand.100' }}
                    onClick={() => filesInputRef.current?.click()}
                    isDisabled={isLoading}
                    justifyContent="flex-start"
                    textAlign="left"
                    overflow="hidden"
                  >
                    {files?.length ? `${files.length} file(s) selected` : 'Select CSV files'}
                  </Button>
                </Stack>
              </Box>

              <HStack justify="flex-end" spacing="3" flexWrap="wrap">
                <Text fontSize="sm" color="ink.700">
                  {files?.length
                    ? `${files.length} CSV file(s) ready.`
                    : 'Select CSV files to begin.'}
                </Text>
                <Button
                  size="sm"
                  bg="tide.500"
                  color="white"
                  _hover={{ bg: 'tide.400' }}
                  onClick={handleAnalyze}
                  loading={isLoading}
                  isDisabled={!files?.length}
                >
                  Analyze
                </Button>
              </HStack>

              {error && (
                <Text fontSize="sm" color="violet.400">
                  {error}
                </Text>
              )}
            </Stack>
          </Box>

          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            overflow="hidden"
          >
            <Box
              px="4"
              py="3"
              borderBottom="1px solid"
              borderColor="sand.200"
              bg="sand.200"
            >
              <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                Results
              </Text>
            </Box>

            {isLoading && (
              <Box px="4" py="6">
                <HStack spacing="2">
                  <Spinner size="sm" color="tide.400" />
                  <Text fontSize="sm" color="ink.700">
                    Analyzing files...
                  </Text>
                </HStack>
              </Box>
            )}

            {!isLoading && rows.length === 0 && (
              <Box px="4" py="6">
                <Text fontSize="sm" color="ink.700">
                  Upload CSV files and click Analyze to see results.
                </Text>
              </Box>
            )}

            {!isLoading && rows.length > 0 && (
              <Box overflowX="auto">
                <Box minW="960px">
                  <Grid
                    templateColumns={TABLE_COLUMNS}
                    px="4"
                    py="3"
                    bg="sand.200"
                    borderBottom="1px solid"
                    borderColor="sand.200"
                    gap="4"
                  >
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                      Filename
                    </Text>
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                      Mean Length (um)
                    </Text>
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                      Nagg Rate
                    </Text>
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                      Heatmap (abs)
                    </Text>
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                      Heatmap (rel)
                    </Text>
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                      Distribution
                    </Text>
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                      Distribution Box
                    </Text>
                  </Grid>

                  {rows.map((filename, index) => {
                    const result = resultsByName.get(filename)
                    const urls = heatmaps[filename]

                    return (
                      <Grid
                        key={`${filename}-${index}`}
                        templateColumns={TABLE_COLUMNS}
                        px="4"
                        py="3"
                        borderBottom={index === rows.length - 1 ? 'none' : '1px solid'}
                        borderColor="sand.200"
                        gap="4"
                        alignItems="center"
                        _hover={{ bg: 'sand.200' }}
                        transition="background 0.2s ease"
                      >
                        <Text fontSize="sm" fontWeight="500">
                          {filename}
                        </Text>
                        <Text fontSize="sm" color="ink.700">
                          {formatNumber(result?.mean_length)}
                        </Text>
                        <Text fontSize="sm" color="ink.700">
                          {formatPercent(result?.nagg_rate)}
                        </Text>
                        <Box>
                          {urls?.abs ? (
                            <AspectRatio ratio={1} w="120px">
                              <Box
                                as="img"
                                src={urls.abs}
                                alt="heatmap abs"
                                objectFit="contain"
                              />
                            </AspectRatio>
                          ) : (
                            <Box
                              w="120px"
                              h="120px"
                              bg="sand.200"
                              borderRadius="md"
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                            >
                              <Text fontSize="xs" color="ink.700">
                                -
                              </Text>
                            </Box>
                          )}
                        </Box>
                        <Box>
                          {urls?.rel ? (
                            <AspectRatio ratio={1} w="120px">
                              <Box
                                as="img"
                                src={urls.rel}
                                alt="heatmap rel"
                                objectFit="contain"
                              />
                            </AspectRatio>
                          ) : (
                            <Box
                              w="120px"
                              h="120px"
                              bg="sand.200"
                              borderRadius="md"
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                            >
                              <Text fontSize="xs" color="ink.700">
                                -
                              </Text>
                            </Box>
                          )}
                        </Box>
                        <Box>
                          {urls?.dist ? (
                            <AspectRatio ratio={1} w="120px">
                              <Box
                                as="img"
                                src={urls.dist}
                                alt="distribution"
                                objectFit="contain"
                              />
                            </AspectRatio>
                          ) : (
                            <Box
                              w="120px"
                              h="120px"
                              bg="sand.200"
                              borderRadius="md"
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                            >
                              <Text fontSize="xs" color="ink.700">
                                -
                              </Text>
                            </Box>
                          )}
                        </Box>
                        <Box>
                          {urls?.dist_box ? (
                            <AspectRatio ratio={1} w="120px">
                              <Box
                                as="img"
                                src={urls.dist_box}
                                alt="distribution box"
                                objectFit="contain"
                              />
                            </AspectRatio>
                          ) : (
                            <Box
                              w="120px"
                              h="120px"
                              bg="sand.200"
                              borderRadius="md"
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                            >
                              <Text fontSize="xs" color="ink.700">
                                -
                              </Text>
                            </Box>
                          )}
                        </Box>
                      </Grid>
                    )
                  })}
                </Box>
              </Box>
            )}
          </Box>
        </Stack>
      </Container>

      <input
        ref={ctrlInputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={handleCtrlChange}
      />
      <input
        ref={filesInputRef}
        type="file"
        accept=".csv"
        multiple
        style={{ display: 'none' }}
        onChange={handleFilesChange}
      />
    </Box>
  )
}
