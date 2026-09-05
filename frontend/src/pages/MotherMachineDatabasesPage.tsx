import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Box,
  BreadcrumbCurrentLink,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbRoot,
  BreadcrumbSeparator,
  Button,
  Grid,
  HStack,
  Icon,
  Input,
  InputGroup,
  Stack,
  Text,
} from '@chakra-ui/react'
import { Download, Search, Trash2 } from 'lucide-react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import PageContainer from '../components/PageContainer'
import MotherMachineHelpDrawer from '../components/MotherMachineHelpDrawer'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type MotherMachineDatabase = {
  name: string
  size_bytes: number
  modified_time: string
  source_filename: string | null
  review_filename: string | null
}

type DatabasesResponse = { databases?: MotherMachineDatabase[] }

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

export default function MotherMachineDatabasesPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const apiBase = useMemo(() => getApiBase(), [])
  const [databases, setDatabases] = useState<MotherMachineDatabase[]>([])
  const [searchText, setSearchText] = useState(() => searchParams.get('search_dbname') ?? '')
  const [isLoading, setIsLoading] = useState(true)
  const [deletingDatabase, setDeletingDatabase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchDatabases = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`${apiBase}/mother-machine/databases`)
      if (!response.ok) throw new Error(await errorMessage(response, 'Failed to load databases'))
      const data = (await response.json()) as DatabasesResponse
      setDatabases(Array.isArray(data.databases) ? data.databases : [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load databases')
      setDatabases([])
    } finally {
      setIsLoading(false)
    }
  }, [apiBase])

  useEffect(() => { void fetchDatabases() }, [fetchDatabases])

  const filteredDatabases = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return databases
    return databases.filter((database) =>
      database.name.toLowerCase().includes(query)
      || database.source_filename?.toLowerCase().includes(query),
    )
  }, [databases, searchText])

  const handleDelete = useCallback(async (name: string) => {
    if (!window.confirm(`Delete ${name}?`)) return
    setDeletingDatabase(name)
    setError(null)
    try {
      const response = await fetch(
        `${apiBase}/mother-machine/databases/${encodeURIComponent(name)}`,
        { method: 'DELETE', headers: { accept: 'application/json' } },
      )
      if (!response.ok) throw new Error(await errorMessage(response, 'Delete failed'))
      await fetchDatabases()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to delete database')
    } finally {
      setDeletingDatabase(null)
    }
  }, [apiBase, fetchDatabases])

  return (
    <Box minH="100vh" bg="sand.50" color="ink.900">
      <PageHeader actions={<><ReloadButton /><ThemeToggleButton /><MotherMachineHelpDrawer page="databases" /></>} />
      <PageContainer>
        <Stack spacing="6">
          <PageBreadcrumb>
            <BreadcrumbRoot fontSize="sm" color="ink.700">
              <BreadcrumbList>
                <BreadcrumbItem><BreadcrumbLink as={RouterLink} to="/">Home</BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem><BreadcrumbLink as={RouterLink} to="/mother-machine/nd2files">Mother Machine</BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem><BreadcrumbCurrentLink color="ink.900">Databases</BreadcrumbCurrentLink></BreadcrumbItem>
              </BreadcrumbList>
            </BreadcrumbRoot>
          </PageBreadcrumb>

          <HStack justify="space-between" align="center" flexWrap="wrap" gap="3">
            <InputGroup size="sm" maxW="360px" startElement={<Search size={16} />} bg="sand.100" borderRadius="md">
              <Input
                placeholder="Search databases"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                border="1px solid"
                borderColor="sand.200"
              />
            </InputGroup>
            <Text fontSize="xs" color="ink.700">{filteredDatabases.length} databases</Text>
          </HStack>

          {error && <Box p="3" borderRadius="md" bg="red.50" border="1px solid" borderColor="red.200"><Text fontSize="sm" color="red.700">{error}</Text></Box>}

          <Box border="1px solid" borderColor="sand.200" borderRadius="xl" overflow="hidden" bg="sand.100">
            {isLoading && <Text px="4" py="6" color="ink.700">Loading databases…</Text>}
            {!isLoading && filteredDatabases.length === 0 && (
              <Text px="4" py="6" color="ink.700">{databases.length === 0 ? 'No Mother Machine databases yet.' : 'No matching databases.'}</Text>
            )}
            {!isLoading && filteredDatabases.map((database, index) => (
              <Grid
                key={database.name}
                templateColumns={{ base: '1fr', md: 'minmax(0, 1fr) auto' }}
                gap="3"
                alignItems="center"
                px="4"
                py="3"
                borderBottom={index === filteredDatabases.length - 1 ? 'none' : '1px solid'}
                borderColor="sand.200"
                _hover={{ bg: 'sand.200' }}
              >
                <Box minW="0">
                  <Text fontSize="sm" fontWeight="600" overflow="hidden" textOverflow="ellipsis">{database.name}</Text>
                  <Text fontSize="xs" color="ink.700">
                    {database.source_filename ?? 'Unknown source'} · {formatBytes(database.size_bytes)} · {new Date(database.modified_time).toLocaleString()}
                  </Text>
                </Box>
                <HStack spacing="2" flexWrap="wrap">
                  <Button
                    size="xs"
                    onClick={() => database.review_filename && navigate(`/mother-machine/cell-extraction?filename=${encodeURIComponent(database.review_filename)}`)}
                    disabled={!database.review_filename || deletingDatabase !== null}
                    variant="outline"
                  >
                    Review
                  </Button>
                  <Button
                    size="xs"
                    as="a"
                    variant="outline"
                    href={`${apiBase}/mother-machine/databases/${encodeURIComponent(database.name)}/download`}
                    download={database.name}
                    disabled={deletingDatabase !== null}
                    aria-label={`Download ${database.name}`}
                  >
                    <Icon as={Download} /> Download
                  </Button>
                  <Button
                    size="xs"
                    colorPalette="red"
                    onClick={() => void handleDelete(database.name)}
                    loading={deletingDatabase === database.name}
                    disabled={deletingDatabase !== null}
                    aria-label={`Delete ${database.name}`}
                  >
                    <Icon as={Trash2} />
                  </Button>
                </HStack>
              </Grid>
            ))}
          </Box>
        </Stack>
      </PageContainer>
    </Box>
  )
}
