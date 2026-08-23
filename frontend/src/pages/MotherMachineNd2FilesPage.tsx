import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
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
  Checkbox,
  Container,
  Grid,
  Heading,
  HStack,
  Icon,
  Input,
  InputGroup,
  Stack,
  Text,
} from '@chakra-ui/react'
import { Download, Info, RotateCcw, Search, Trash2, Upload } from 'lucide-react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import MotherMachineHelpDrawer from '../components/MotherMachineHelpDrawer'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type MotherMachineFile = {
  filename: string
  size_bytes: number
  modified_time: string
  has_dataset: boolean
}

type FilesResponse = {
  files?: MotherMachineFile[]
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

const errorMessage = async (response: Response, fallback: string) => {
  try {
    const body = (await response.json()) as { detail?: string }
    return body.detail || `${fallback} (${response.status})`
  } catch {
    return `${fallback} (${response.status})`
  }
}

export default function MotherMachineNd2FilesPage() {
  const navigate = useNavigate()
  const apiBase = useMemo(() => getApiBase(), [])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<MotherMachineFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [searchText, setSearchText] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [metadataFile, setMetadataFile] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<unknown | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)

  const fetchFiles = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`${apiBase}/mother-machine/nd2-files`)
      if (!response.ok) throw new Error(await errorMessage(response, 'Failed to load files'))
      const data = (await response.json()) as FilesResponse
      setFiles(Array.isArray(data.files) ? data.files : [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load files')
      setFiles([])
    } finally {
      setIsLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    void fetchFiles()
  }, [fetchFiles])

  useEffect(() => {
    const available = new Set(files.map((file) => file.filename))
    setSelectedFiles((current) => {
      const next = new Set(Array.from(current).filter((file) => available.has(file)))
      return next.size === current.size ? current : next
    })
  }, [files])

  const uploadFile = useCallback(
    async (file: File) => {
      setIsUploading(true)
      setError(null)
      try {
        const formData = new FormData()
        formData.append('file', file)
        const response = await fetch(`${apiBase}/mother-machine/nd2-files`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) throw new Error(await errorMessage(response, 'Upload failed'))
        await fetchFiles()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Upload failed')
      } finally {
        setIsUploading(false)
      }
    },
    [apiBase, fetchFiles],
  )

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void uploadFile(file)
    event.target.value = ''
  }

  const deleteFiles = useCallback(
    async (filenames: string[]) => {
      if (filenames.length === 0) return
      const confirmed = window.confirm(
        `Delete ${filenames.length} ND2 file(s) and their extracted Mother Machine data?`,
      )
      if (!confirmed) return
      setError(null)
      if (filenames.length === 1) setDeletingFile(filenames[0])
      else setIsBulkDeleting(true)
      try {
        const response =
          filenames.length === 1
            ? await fetch(
                `${apiBase}/mother-machine/nd2-files/${encodeURIComponent(filenames[0])}`,
                { method: 'DELETE' },
              )
            : await fetch(`${apiBase}/mother-machine/nd2-files/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filenames }),
              })
        if (!response.ok) throw new Error(await errorMessage(response, 'Delete failed'))
        setSelectedFiles(new Set())
        await fetchFiles()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Delete failed')
      } finally {
        setDeletingFile(null)
        setIsBulkDeleting(false)
      }
    },
    [apiBase, fetchFiles],
  )

  const showMetadata = useCallback(
    async (filename: string) => {
      setMetadataFile(filename)
      setMetadata(null)
      setMetadataLoading(true)
      try {
        const response = await fetch(
          `${apiBase}/mother-machine/nd2-files/${encodeURIComponent(filename)}/metadata`,
        )
        if (!response.ok) throw new Error(await errorMessage(response, 'Metadata failed'))
        setMetadata(await response.json())
      } catch (caught) {
        setMetadata({ error: caught instanceof Error ? caught.message : 'Metadata failed' })
      } finally {
        setMetadataLoading(false)
      }
    },
    [apiBase],
  )

  const filteredFiles = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return files
    return files.filter((file) => file.filename.toLowerCase().includes(query))
  }, [files, searchText])
  const allFilteredSelected =
    filteredFiles.length > 0 &&
    filteredFiles.every((file) => selectedFiles.has(file.filename))

  const toggleSelected = (filename: string, checked: boolean) => {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (checked) next.add(filename)
      else next.delete(filename)
      return next
    })
  }

  const toggleAll = (checked: boolean) => {
    setSelectedFiles((current) => {
      const next = new Set(current)
      filteredFiles.forEach((file) => {
        if (checked) next.add(file.filename)
        else next.delete(file.filename)
      })
      return next
    })
  }

  return (
    <Box minH="100vh" bg="sand.50" color="ink.900">
      <PageHeader actions={<><ReloadButton /><ThemeToggleButton /><MotherMachineHelpDrawer page="nd2-files" /></>} />
      <Container maxW="72.5rem" py={{ base: 8, md: 12 }}>
        <PageBreadcrumb>
          <BreadcrumbRoot fontSize="sm" color="ink.700">
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink as={RouterLink} to="/">Dashboard</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem><BreadcrumbLink as={RouterLink} to="/mother-machine/nd2files">Mother Machine</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem><BreadcrumbCurrentLink color="ink.900">Mother Machine ND2 Files</BreadcrumbCurrentLink></BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>

        <Stack spacing="6">
          <Stack spacing="2">
            <Heading size="lg">Mother Machine ND2 files</Heading>
            <Text color="ink.700" fontSize="sm">
              Upload and manage time-lapse ND2 files in the isolated Mother Machine workspace.
            </Text>
          </Stack>

          <Grid templateColumns={{ base: '1fr', md: 'minmax(0, 1fr) auto' }} gap="3">
            <InputGroup startElement={<Search size={16} />} maxW="420px">
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search Mother Machine ND2 files"
                bg="sand.100"
                borderColor="sand.200"
              />
            </InputGroup>
            <Button
              bg="tide.500"
              color="white"
              _hover={{ bg: 'tide.400' }}
              onClick={() => inputRef.current?.click()}
              loading={isUploading}
            >
              <Icon as={Upload} /> Upload ND2
            </Button>
          </Grid>

          <HStack justify="space-between" flexWrap="wrap" gap="3">
            <Checkbox.Root
              checked={allFilteredSelected}
              onCheckedChange={(details) => toggleAll(details.checked === true)}
              display="flex"
              alignItems="center"
              gap="2"
              colorPalette="tide"
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label fontSize="sm">Select all ({selectedFiles.size} selected)</Checkbox.Label>
            </Checkbox.Root>
            <Button
              size="sm"
              colorPalette="red"
              variant="solid"
              disabled={selectedFiles.size === 0}
              loading={isBulkDeleting}
              onClick={() => void deleteFiles(Array.from(selectedFiles))}
            >
              Delete selected
            </Button>
          </HStack>

          {error && (
            <Box p="3" borderRadius="md" bg="red.50" border="1px solid" borderColor="red.200">
              <Text fontSize="sm" color="red.700">{error}</Text>
            </Box>
          )}

          <Box border="1px solid" borderColor="sand.200" borderRadius="xl" overflow="hidden" bg="sand.100">
            {isLoading && <Text px="4" py="6" color="ink.700">Loading files…</Text>}
            {!isLoading && filteredFiles.length === 0 && (
              <Text px="4" py="6" color="ink.700">
                {files.length === 0 ? 'No Mother Machine ND2 files yet.' : 'No matching files.'}
              </Text>
            )}
            {!isLoading && filteredFiles.map((file, index) => (
              <Grid
                key={file.filename}
                templateColumns={{ base: '1fr', lg: 'minmax(0, 1fr) auto' }}
                gap="3"
                alignItems="center"
                px="4"
                py="3"
                borderBottom={index === filteredFiles.length - 1 ? 'none' : '1px solid'}
                borderColor="sand.200"
                _hover={{ bg: 'sand.200' }}
              >
                <HStack minW="0" spacing="3">
                  <Checkbox.Root
                    checked={selectedFiles.has(file.filename)}
                    onCheckedChange={(details) => toggleSelected(file.filename, details.checked === true)}
                    colorPalette="tide"
                  >
                    <Checkbox.HiddenInput /><Checkbox.Control />
                  </Checkbox.Root>
                  <Box minW="0">
                    <HStack spacing="2" flexWrap="wrap">
                      <Text fontSize="sm" fontWeight="600" overflow="hidden" textOverflow="ellipsis">
                        {file.filename}
                      </Text>
                      {file.has_dataset && <Badge colorPalette="green">Extracted</Badge>}
                    </HStack>
                    <Text fontSize="xs" color="ink.700">
                      {formatBytes(file.size_bytes)} · {new Date(file.modified_time).toLocaleString()}
                    </Text>
                  </Box>
                </HStack>
                <HStack spacing="2" flexWrap="wrap" justify={{ base: 'flex-start', lg: 'flex-end' }}>
                  <Button
                    size="xs"
                    bg="tide.500"
                    color="white"
                    _hover={{ bg: 'tide.400' }}
                    onClick={() => navigate(
                      `/mother-machine/cell-extraction?filename=${encodeURIComponent(file.filename)}`,
                    )}
                  >
                    {file.has_dataset ? 'Review cells' : 'Extract cells'}
                  </Button>
                  {file.has_dataset && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => navigate(
                        `/mother-machine/cell-extraction?filename=${encodeURIComponent(file.filename)}`,
                      )}
                    >
                      <Icon as={RotateCcw} /> Re-extract
                    </Button>
                  )}
                  <Button size="xs" variant="outline" onClick={() => void showMetadata(file.filename)} aria-label="Metadata">
                    <Icon as={Info} /> Metadata
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    as="a"
                    href={`${apiBase}/mother-machine/nd2-files/${encodeURIComponent(file.filename)}/download`}
                    download={file.filename}
                    aria-label="Download"
                  >
                    <Icon as={Download} /> Download
                  </Button>
                  <Button
                    size="xs"
                    colorPalette="red"
                    onClick={() => void deleteFiles([file.filename])}
                    loading={deletingFile === file.filename}
                    aria-label={`Delete ${file.filename}`}
                  >
                    <Icon as={Trash2} />
                  </Button>
                </HStack>
              </Grid>
            ))}
          </Box>
        </Stack>
      </Container>

      <input ref={inputRef} type="file" accept=".nd2" hidden onChange={handleFileChange} />

      {metadataFile && (
        <Box
          position="fixed"
          inset="0"
          bg="rgba(11, 13, 16, 0.6)"
          zIndex={1400}
          display="flex"
          alignItems="center"
          justifyContent="center"
          p="4"
          onClick={() => setMetadataFile(null)}
        >
          <Box
            role="dialog"
            aria-modal="true"
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            p="4"
            w="full"
            maxW="760px"
            maxH="80vh"
            onClick={(event) => event.stopPropagation()}
          >
            <HStack justify="space-between" mb="3">
              <Text fontWeight="600">Metadata: {metadataFile}</Text>
              <Button size="xs" onClick={() => setMetadataFile(null)}>Close</Button>
            </HStack>
            <Box as="pre" p="3" bg="sand.50" borderRadius="md" overflow="auto" maxH="65vh" fontSize="xs">
              {metadataLoading ? 'Loading…' : JSON.stringify(metadata, null, 2)}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}
