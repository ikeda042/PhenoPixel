import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Box,
  BreadcrumbCurrentLink,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbRoot,
  BreadcrumbSeparator,
  Grid,
  HStack,
  Icon,
  Input,
  InputGroup,
  Stack,
  Text,
  Button,
} from '@chakra-ui/react'
import { Download, Pencil, Search, Trash2 } from 'lucide-react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import PageContainer from '../components/PageContainer'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

const SearchGlyph = () => (
  <Box position="relative" w="16px" h="16px" color="ink.700">
    <Search size={16} />
  </Box>
)

const PAGE_SIZE = 50

export default function DatabasesPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const apiBase = useMemo(() => getApiBase(), [])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [databases, setDatabases] = useState<string[]>([])
  const [searchText, setSearchText] = useState(() => searchParams.get('search_dbname') ?? '')
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [downloadingDatabase, setDownloadingDatabase] = useState<string | null>(null)
  const [deletingDatabase, setDeletingDatabase] = useState<string | null>(null)
  const [renamingDatabase, setRenamingDatabase] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)

  const fetchDatabases = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/get-databases`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const data = (await res.json()) as string[]
      setDatabases(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load databases')
      setDatabases([])
    } finally {
      setIsLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    void fetchDatabases()
  }, [fetchDatabases])

  useEffect(() => {
    const nextSearch = searchParams.get('search_dbname') ?? ''
    setSearchText((prev) => (prev === nextSearch ? prev : nextSearch))
  }, [searchParams])

  useEffect(() => {
    setPage(1)
  }, [searchText])

  const filteredDatabases = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return databases
    return databases.filter((name) => name.toLowerCase().includes(query))
  }, [databases, searchText])


  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredDatabases.length / PAGE_SIZE)),
    [filteredDatabases.length],
  )

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const pagedDatabases = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filteredDatabases.slice(start, start + PAGE_SIZE)
  }, [filteredDatabases, page])

  const rangeStart = filteredDatabases.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const rangeEnd = Math.min(page * PAGE_SIZE, filteredDatabases.length)
  const canGoPrev = page > 1
  const canGoNext = page < totalPages

  const uploadDatabase = useCallback(
    async (file: File) => {
      setIsUploading(true)
      setError(null)
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch(`${apiBase}/database_files`, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: formData,
        })
        if (!res.ok) {
          throw new Error(`Upload failed (${res.status})`)
        }
        await res.json()
        await fetchDatabases()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to upload database')
      } finally {
        setIsUploading(false)
      }
    },
    [apiBase, fetchDatabases],
  )

  const handleDownload = useCallback(
    async (dbName: string) => {
      if (downloadingDatabase || deletingDatabase || isRenaming || renamingDatabase)
        return
      setDownloadingDatabase(dbName)
      setError(null)
      try {
        const res = await fetch(
          `${apiBase}/database_files/${encodeURIComponent(dbName)}`,
          { headers: { accept: 'application/octet-stream' } },
        )
        if (!res.ok) {
          throw new Error(`Download failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = dbName
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to download database')
      } finally {
        setDownloadingDatabase(null)
      }
    },
    [apiBase, deletingDatabase, downloadingDatabase, isRenaming, renamingDatabase],
  )

  const handleDelete = useCallback(
    async (dbName: string) => {
      if (downloadingDatabase || deletingDatabase || isRenaming || renamingDatabase)
        return
      const confirmed = window.confirm(`Delete ${dbName}?`)
      if (!confirmed) return
      setDeletingDatabase(dbName)
      setError(null)
      try {
        const res = await fetch(
          `${apiBase}/database_files/${encodeURIComponent(dbName)}`,
          { method: 'DELETE', headers: { accept: 'application/json' } },
        )
        if (!res.ok) {
          throw new Error(`Delete failed (${res.status})`)
        }
        await res.json()
        await fetchDatabases()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete database')
      } finally {
        setDeletingDatabase(null)
      }
    },
    [
      apiBase,
      deletingDatabase,
      downloadingDatabase,
      fetchDatabases,
      isRenaming,
      renamingDatabase,
    ],
  )

  const beginRename = useCallback((dbName: string) => {
    setError(null)
    setRenamingDatabase(dbName)
    setRenameValue(dbName)
  }, [])

  const cancelRename = useCallback(() => {
    setRenamingDatabase(null)
    setRenameValue('')
  }, [])

  const confirmRename = useCallback(async () => {
    if (!renamingDatabase) return
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setError('Database name is required')
      return
    }
    if (!trimmed.toLowerCase().endsWith('.db')) {
      setError('Database name must end with .db')
      return
    }
    if (trimmed === renamingDatabase) {
      cancelRename()
      return
    }
    setIsRenaming(true)
    setError(null)
    try {
      const params = new URLSearchParams({ new_name: trimmed })
      const res = await fetch(
        `${apiBase}/database_files/${encodeURIComponent(renamingDatabase)}?${params.toString()}`,
        { method: 'PATCH', headers: { accept: 'application/json' } },
      )
      if (!res.ok) {
        let message = `Rename failed (${res.status})`
        try {
          const data = (await res.json()) as { detail?: string }
          if (data?.detail) {
            message = data.detail
          }
        } catch {
          // ignore json parse failures
        }
        throw new Error(message)
      }
      await res.json()
      await fetchDatabases()
      cancelRename()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename database')
    } finally {
      setIsRenaming(false)
    }
  }, [apiBase, cancelRename, fetchDatabases, renameValue, renamingDatabase])

  useEffect(() => {
    if (renamingDatabase && !filteredDatabases.includes(renamingDatabase)) {
      cancelRename()
    }
  }, [cancelRename, filteredDatabases, renamingDatabase])

  const handleUploadClick = () => {
    inputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.db')) {
      setError('Only .db files are supported')
      event.target.value = ''
      return
    }
    void uploadDatabase(file)
    event.target.value = ''
  }

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

      <PageContainer>
        <Stack spacing="6">
          <Box
            position="sticky"
            top="var(--app-header-height)"
            zIndex="docked"
            bg="sand.50"
            pt={{ base: 1, md: 2 }}
            pb="4"
            borderBottom="1px solid"
            borderColor="sand.200"
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
                    <BreadcrumbCurrentLink color="ink.900">
                      Databases
                    </BreadcrumbCurrentLink>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </BreadcrumbRoot>
            </PageBreadcrumb>
            <Stack spacing="4">
              <Stack
                direction={{ base: 'column', md: 'row' }}
                align={{ base: 'stretch', md: 'center' }}
                justify="space-between"
                gap="3"
              >
                <InputGroup
                  size="sm"
                  maxW={{ base: '100%', md: '360px' }}
                  startElement={<SearchGlyph />}
                  bg="sand.100"
                  borderRadius="md"
                >
                  <Input
                    placeholder="Search databases"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    disabled={Boolean(renamingDatabase) || isRenaming}
                    border="1px solid"
                    borderColor="sand.200"
                    color="ink.900"
                    _placeholder={{ color: 'ink.700' }}
                    _focusVisible={{
                      borderColor: 'tide.400',
                      boxShadow: '0 0 0 1px var(--app-accent-ring)',
                    }}
                  />
                </InputGroup>

                <Button
                  size="sm"
                  onClick={handleUploadClick}
                  loading={isUploading}
                  alignSelf={{ base: 'flex-start', md: 'center' }}
                  variant="outline"
                >
                  Upload DB
                </Button>
              </Stack>

              <HStack justify="space-between" flexWrap="wrap" gap="3">
                <Text fontSize="xs" color="ink.700">
                  {filteredDatabases.length === 0
                    ? 'No databases'
                    : `Showing ${rangeStart}-${rangeEnd} of ${filteredDatabases.length}`}
                </Text>
                <HStack spacing="2" align="center">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                    disabled={!canGoPrev || renamingDatabase !== null || isRenaming}
                  >
                    Prev
                  </Button>
                  <Text fontSize="xs" color="ink.700">
                    Page {page} / {totalPages}
                  </Text>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                    disabled={!canGoNext || renamingDatabase !== null || isRenaming}
                  >
                    Next
                  </Button>
                </HStack>
              </HStack>
            </Stack>
          </Box>

          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            overflow="hidden"
            overflowY="auto"
            maxH={{ base: '60vh', md: 'calc(100vh - 260px)' }}
          >
            <Grid
              templateColumns={{ base: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 26rem' }}
              px="4"
              py="3"
              bg="sand.200"
              borderBottom="1px solid"
              borderColor="sand.200"
              position="sticky"
              top="0"
              zIndex="1"
            >
              <Box />
              <Text
                fontSize="xs"
                color="ink.700"
                textAlign={{ base: 'left', md: 'center' }}
              >
                Actions
              </Text>
            </Grid>

            {isLoading && (
              <Box px="4" py="5">
                <Text fontSize="sm" color="ink.700">
                  Loading databases...
                </Text>
              </Box>
            )}

            {!isLoading && error && (
              <Box px="4" py="5">
                <Text fontSize="sm" color="violet.300">
                  {error}
                </Text>
              </Box>
            )}

            {!isLoading && !error && databases.length === 0 && (
              <Box px="4" py="5">
                <Text fontSize="sm" color="ink.700">
                  No databases found.
                </Text>
              </Box>
            )}

            {!isLoading &&
              !error &&
              databases.length > 0 &&
              filteredDatabases.length === 0 && (
                <Box px="4" py="5">
                  <Text fontSize="sm" color="ink.700">
                    No matching databases.
                  </Text>
                </Box>
              )}

            {!isLoading &&
              !error &&
              pagedDatabases.map((name, index) => {
                const isEditing = renamingDatabase === name
                const disableActions =
                  isRenaming ||
                  downloadingDatabase ||
                  deletingDatabase ||
                  (renamingDatabase !== null && !isEditing)
                return (
                  <Grid
                    key={name}
                    templateColumns={{
                      base: 'minmax(0, 1fr)',
                      md: 'minmax(0, 1fr) 26rem',
                    }}
                    px="4"
                    py="3"
                    borderBottom={
                      index === pagedDatabases.length - 1 ? 'none' : '1px solid'
                    }
                    borderColor="sand.200"
                    _hover={{ bg: 'sand.200' }}
                    transition="background 0.2s ease"
                  >
                    {isEditing ? (
                      <Input
                        size="sm"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void confirmRename()
                          }
                          if (event.key === 'Escape') {
                            cancelRename()
                          }
                        }}
                        border="1px solid"
                        borderColor="sand.200"
                        color="ink.900"
                        _focusVisible={{
                          borderColor: 'tide.400',
                          boxShadow: '0 0 0 1px var(--app-accent-ring)',
                        }}
                        autoFocus
                      />
                    ) : (
                      <Text fontSize="sm" fontWeight="500">
                        {name}
                      </Text>
                    )}
                    <HStack
                      spacing="2"
                      justify={{ base: 'flex-start', md: 'flex-end' }}
                      flexWrap={{ base: 'wrap', md: 'nowrap' }}
                    >
                      {isEditing ? (
                        <>
                          <Button
                            size="xs"
                            onClick={() => void confirmRename()}
                            loading={isRenaming}
                            disabled={isRenaming}
                            variant="outline"
                          >
                            Save
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            borderColor="sand.300"
                            color="ink.700"
                            _hover={{ bg: 'sand.200' }}
                            onClick={cancelRename}
                            disabled={isRenaming}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="xs"
                            onClick={() =>
                              navigate(`/cells?db=${encodeURIComponent(name)}`)
                            }
                            disabled={disableActions}
                            variant="outline"
                          >
                            Access
                          </Button>
                          <Button
                            size="xs"
                            onClick={() =>
                              navigate(
                                `/annotation?dbname=${encodeURIComponent(name)}`,
                              )
                            }
                            disabled={disableActions}
                            variant="outline"
                          >
                            Annotation
                          </Button>
                          <Button
                            size="xs"
                            onClick={() =>
                              navigate(
                                `/bulk-engine?dbname=${encodeURIComponent(name)}`,
                              )
                            }
                            disabled={disableActions}
                            variant="outline"
                          >
                            Bulk-engine
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => beginRename(name)}
                            disabled={disableActions}
                            aria-label={`Rename ${name}`}
                            minW="auto"
                            px="2"
                          >
                            <Icon as={Pencil} boxSize={3.5} />
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => handleDownload(name)}
                            loading={downloadingDatabase === name}
                            aria-label={`Download ${name}`}
                            disabled={disableActions}
                            minW="auto"
                            px="2"
                          >
                            <Icon as={Download} boxSize={3.5} />
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => handleDelete(name)}
                            loading={deletingDatabase === name}
                            aria-label={`Delete ${name}`}
                            minW="auto"
                            px="2"
                            disabled={disableActions}
                            colorPalette="red"
                          >
                            <Icon as={Trash2} boxSize={3.5} />
                          </Button>
                        </>
                      )}
                    </HStack>
                  </Grid>
                )
              })}
          </Box>
        </Stack>
      </PageContainer>

      <input
        ref={inputRef}
        type="file"
        accept=".db"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </Box>
  )
}
