import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Link as RouterLink } from 'react-router-dom'
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
  Grid,
  HStack,
  Icon,
  Input,
  InputGroup,
  Stack,
  Text,
} from '@chakra-ui/react'
import { Search, Trash2 } from 'lucide-react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type ManagedFile = {
  name: string
  size: number
  modified: number
}

type FileListResponse = {
  files?: ManagedFile[]
}

const SearchGlyph = () => (
  <Box position="relative" w="16px" h="16px" color="ink.700">
    <Search size={16} />
  </Box>
)

const formatFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  const precision = size < 10 ? 1 : 0
  return `${size.toFixed(precision)} ${units[index]}`
}

const formatTimestamp = (timestamp: number) => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
  return new Date(timestamp * 1000).toLocaleString()
}

export default function FilesPage() {
  const apiBase = useMemo(() => getApiBase(), [])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<ManagedFile[]>([])
  const [searchText, setSearchText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchFiles = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/filemanager/files`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const data = (await res.json()) as FileListResponse
      const nextFiles = Array.isArray(data.files)
        ? data.files
            .filter((file) => file && typeof file === 'object')
            .map((file) => ({
              name: typeof file.name === 'string' ? file.name : '',
              size: typeof file.size === 'number' ? file.size : 0,
              modified: typeof file.modified === 'number' ? file.modified : 0,
            }))
            .filter((file) => file.name)
        : []
      setFiles(nextFiles)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files')
      setFiles([])
    } finally {
      setIsLoading(false)
    }
  }, [apiBase])

  const uploadFile = useCallback(
    async (file: File) => {
      setIsUploading(true)
      setError(null)
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch(`${apiBase}/filemanager/files`, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: formData,
        })
        if (!res.ok) {
          throw new Error(`Upload failed (${res.status})`)
        }
        await res.json()
        await fetchFiles()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to upload file')
      } finally {
        setIsUploading(false)
      }
    },
    [apiBase, fetchFiles],
  )

  const handleDownload = useCallback(
    async (file: ManagedFile) => {
      if (downloadingFile || deletingFile) return
      setDownloadingFile(file.name)
      setError(null)
      try {
        const res = await fetch(
          `${apiBase}/filemanager/files/${encodeURIComponent(file.name)}`,
          { headers: { accept: 'application/octet-stream' } },
        )
        if (!res.ok) {
          throw new Error(`Download failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = file.name
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to download file')
      } finally {
        setDownloadingFile(null)
      }
    },
    [apiBase, deletingFile, downloadingFile],
  )

  const handleDelete = useCallback(
    async (file: ManagedFile) => {
      if (deletingFile || downloadingFile) return
      const confirmed = window.confirm(`Delete ${file.name}?`)
      if (!confirmed) return
      setDeletingFile(file.name)
      setError(null)
      try {
        const res = await fetch(
          `${apiBase}/filemanager/files/${encodeURIComponent(file.name)}`,
          { method: 'DELETE', headers: { accept: 'application/json' } },
        )
        if (!res.ok) {
          throw new Error(`Delete failed (${res.status})`)
        }
        await res.json()
        await fetchFiles()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete file')
      } finally {
        setDeletingFile(null)
      }
    },
    [apiBase, deletingFile, downloadingFile, fetchFiles],
  )

  useEffect(() => {
    void fetchFiles()
  }, [fetchFiles])

  const handleUploadClick = () => {
    inputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    void uploadFile(file)
    event.target.value = ''
  }

  const filteredFiles = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return files
    return files.filter((file) => file.name.toLowerCase().includes(query))
  }, [files, searchText])

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
                <BreadcrumbCurrentLink color="ink.900">File Manager</BreadcrumbCurrentLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </BreadcrumbRoot>
        </PageBreadcrumb>
        <Stack spacing="6">
          <InputGroup
            size="sm"
            maxW="360px"
            startElement={<SearchGlyph />}
            bg="sand.100"
            borderRadius="md"
          >
            <Input
              placeholder="Search files"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
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

          <HStack justify="space-between" flexWrap="wrap" gap="3">
            <Text fontSize="xs" color="ink.700">
              Files: {filteredFiles.length}
            </Text>
            <Button
              size="sm"
              bg="tide.500"
              color="white"
              _hover={{ bg: 'tide.400' }}
              onClick={handleUploadClick}
              loading={isUploading}
            >
              Upload File
            </Button>
          </HStack>

          <Box
            bg="sand.100"
            border="1px solid"
            borderColor="sand.200"
            borderRadius="xl"
            overflow="hidden"
          >
            <Grid
              templateColumns={{
                base: 'minmax(0, 1fr)',
                md: 'minmax(0, 1fr) 6rem 10rem 12rem',
              }}
              px="4"
              py="3"
              bg="sand.200"
              borderBottom="1px solid"
              borderColor="sand.200"
              gap={{ base: 2, md: 4 }}
            >
              <Text fontSize="xs" color="ink.700" letterSpacing="0.18em">
                Filename
              </Text>
              <Text
                fontSize="xs"
                color="ink.700"
                letterSpacing="0.18em"
                textAlign={{ base: 'left', md: 'right' }}
              >
                Size
              </Text>
              <Text
                fontSize="xs"
                color="ink.700"
                letterSpacing="0.18em"
                textAlign={{ base: 'left', md: 'right' }}
              >
                Updated
              </Text>
              <Text
                fontSize="xs"
                color="ink.700"
                letterSpacing="0.18em"
                textAlign={{ base: 'left', md: 'right' }}
              >
                Action
              </Text>
            </Grid>

            {isLoading && (
              <Box px="4" py="5">
                <Text fontSize="sm" color="ink.700">
                  Loading files...
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

            {!isLoading && !error && files.length === 0 && (
              <Box px="4" py="5">
                <Text fontSize="sm" color="ink.700">
                  No files found.
                </Text>
              </Box>
            )}

            {!isLoading &&
              !error &&
              files.length > 0 &&
              filteredFiles.length === 0 && (
                <Box px="4" py="5">
                  <Text fontSize="sm" color="ink.700">
                    No matching files.
                  </Text>
                </Box>
              )}

            {!isLoading &&
              !error &&
              filteredFiles.map((file, index) => (
                <Grid
                  key={file.name}
                  templateColumns={{
                    base: 'minmax(0, 1fr)',
                    md: 'minmax(0, 1fr) 6rem 10rem 12rem',
                  }}
                  px="4"
                  py="3"
                  borderBottom={index === filteredFiles.length - 1 ? 'none' : '1px solid'}
                  borderColor="sand.200"
                  _hover={{ bg: 'sand.200' }}
                  transition="background 0.2s ease"
                  gap={{ base: 2, md: 4 }}
                  alignItems="center"
                >
                  <Text fontSize="sm" fontWeight="500">
                    {file.name}
                  </Text>
                  <Text
                    fontSize="sm"
                    color="ink.700"
                    textAlign={{ base: 'left', md: 'right' }}
                  >
                    {formatFileSize(file.size)}
                  </Text>
                  <Text
                    fontSize="sm"
                    color="ink.700"
                    textAlign={{ base: 'left', md: 'right' }}
                  >
                    {formatTimestamp(file.modified)}
                  </Text>
                  <HStack justify={{ base: 'flex-start', md: 'flex-end' }} spacing="2">
                    <Button
                      size="xs"
                      variant="outline"
                      borderColor="tide.500"
                      bg="tide.500"
                      color="white"
                      _hover={{ bg: 'tide.400' }}
                      onClick={() => handleDownload(file)}
                      loading={downloadingFile === file.name}
                    >
                      Download
                    </Button>
                    <Button
                      size="xs"
                      bg="violet.400"
                      color="white"
                      _hover={{ bg: 'violet.300' }}
                      onClick={() => handleDelete(file)}
                      loading={deletingFile === file.name}
                      aria-label={`Delete ${file.name}`}
                      minW="auto"
                      px="2"
                    >
                      <Icon as={Trash2} boxSize={3.5} />
                    </Button>
                  </HStack>
                </Grid>
              ))}
          </Box>
        </Stack>
      </Container>

      <input
        ref={inputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </Box>
  )
}
