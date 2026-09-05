import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom'
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
  Check,
  Download,
  Eraser,
  GitMerge,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  Redo2,
  RotateCcw,
  Scissors,
  Undo2,
  Upload,
} from 'lucide-react'
import PageBreadcrumb from '../components/PageBreadcrumb'
import PageHeader from '../components/PageHeader'
import PageContainer from '../components/PageContainer'
import ReloadButton from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'

type Point = [number, number]
type Instance = { id: string; display_order?: number; points: Point[] }
type Dataset = {
  filename: string
  database: string
  status: 'uploading' | 'preparing' | 'annotating' | 'paused' | 'completed'
  current_order: number
  total_frames: number
  reviewed_count: number
  progress_percent: number
  error?: string | null
  job?: { status: string; progress?: { message?: string; processed_frames?: number; total_frames?: number } }
}
type TrainingFrame = {
  id: number
  view_index: number
  roi_id: number
  time_frame: number
  order_index: number
  width: number
  height: number
  status: string
  revision: number
  instances: Instance[]
  previous_frame_id: number | null
  next_frame_id: number | null
}
type Tool = 'select' | 'draw' | 'erase' | 'split'
type UploadConflict = { filename: string; canResume: boolean }

const cloneInstances = (items: Instance[]) => items.map((item) => ({ ...item, points: item.points.map((point) => [...point] as Point) }))
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

const errorMessage = async (response: Response, fallback: string) => {
  try {
    const body = (await response.json()) as { detail?: string }
    return body.detail || `${fallback} (${response.status})`
  } catch {
    return `${fallback} (${response.status})`
  }
}

const convexHull = (points: Point[]): Point[] => {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (sorted.length <= 3) return sorted
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Point[] = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: Point[] = []
  for (const point of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop()
    upper.push(point)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

const clipHorizontal = (points: Point[], cut: number, keepTop: boolean): Point[] => {
  const output: Point[] = []
  const inside = (point: Point) => keepTop ? point[1] <= cut : point[1] >= cut
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const previous = points[(index + points.length - 1) % points.length]
    const currentInside = inside(current)
    const previousInside = inside(previous)
    if (currentInside !== previousInside) {
      const ratio = (cut - previous[1]) / (current[1] - previous[1])
      output.push([previous[0] + (current[0] - previous[0]) * ratio, cut])
    }
    if (currentInside) output.push(current)
  }
  return output
}

export default function MotherMachineCreateDatasetPage() {
  const apiBase = useMemo(() => getApiBase(), [])
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const filename = searchParams.get('filename') ?? ''
  const fileRef = useRef<HTMLInputElement | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const frameLoadInFlightRef = useRef(false)
  const editVersionRef = useRef(0)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [dataset, setDataset] = useState<Dataset | null>(null)
  const [frame, setFrame] = useState<TrainingFrame | null>(null)
  const [instances, setInstances] = useState<Instance[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [history, setHistory] = useState<Instance[][]>([])
  const [future, setFuture] = useState<Instance[][]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [frameInferring, setFrameInferring] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [availableDatasets, setAvailableDatasets] = useState<Dataset[]>([])
  const [uploadConflict, setUploadConflict] = useState<UploadConflict | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [brightness, setBrightness] = useState(100)
  const [contrast, setContrast] = useState(100)
  const [opacity, setOpacity] = useState(48)
  const [draftPoints, setDraftPoints] = useState<Point[]>([])
  const vertexDragRef = useRef<{ id: string; index: number } | null>(null)

  const frameRawUrl = frame ? `${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/frames/${frame.id}/raw.png` : ''
  const neighborUrl = (id: number | null) => id ? `${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/frames/${id}/raw.png` : ''

  const loadFrame = useCallback(async () => {
    if (!filename || frameLoadInFlightRef.current) return
    frameLoadInFlightRef.current = true
    try {
      const response = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/frames/current`)
      if (!response.ok) throw new Error(await errorMessage(response, 'Failed to load frame'))
      let next = (await response.json()) as TrainingFrame
      setFrame(next)
      if (next.status === 'pending' || next.status === 'inferring' || next.status === 'failed') {
        setInstances([])
        setFrameInferring(true)
        setError(null)
        const inference = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/frames/${next.id}/infer`, { method: 'POST' })
        if (!inference.ok) throw new Error(await errorMessage(inference, 'Cellpose inference failed'))
        next = (await inference.json()) as TrainingFrame
        setFrame(next)
      }
      setInstances(cloneInstances(next.instances))
      setSelected([])
      setHistory([])
      setFuture([])
      setDraftPoints([])
      setDirty(false)
      editVersionRef.current = 0
    } catch (caught) {
      setFrame((current) => current ? { ...current, status: 'failed' } : current)
      throw caught
    } finally {
      setFrameInferring(false)
      frameLoadInFlightRef.current = false
    }
  }, [apiBase, filename])

  const loadDataset = useCallback(async () => {
    if (!filename) return
    const response = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}`)
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to load dataset'))
    const next = (await response.json()) as Dataset
    setDataset(next)
    if ((next.status === 'annotating' || next.status === 'paused' || next.status === 'completed') && next.total_frames > 0 && !frame) await loadFrame()
  }, [apiBase, filename, frame, loadFrame])

  useEffect(() => {
    if (!filename) return
    void loadDataset().catch((caught) => setError(caught instanceof Error ? caught.message : 'Failed to load dataset'))
  }, [filename]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (filename) return
    const controller = new AbortController()
    fetch(`${apiBase}/mother-machine/training-datasets`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Failed to load datasets')))
      .then((payload) => setAvailableDatasets(Array.isArray(payload?.datasets) ? payload.datasets : []))
      .catch(() => { if (!controller.signal.aborted) setAvailableDatasets([]) })
    return () => controller.abort()
  }, [apiBase, filename])

  useEffect(() => {
    if (!filename || dataset?.status !== 'preparing') return
    const timer = window.setInterval(() => {
      void loadDataset().catch((caught) => setError(caught instanceof Error ? caught.message : 'Preparation failed'))
    }, 1500)
    return () => window.clearInterval(timer)
  }, [dataset?.status, filename, loadDataset])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) {
        event.preventDefault(); removeSelected()
      }
      if (event.key === 'Enter' && tool === 'draw' && draftPoints.length >= 3) {
        event.preventDefault(); finishDrawing()
      }
      if (event.key === 'Escape' && draftPoints.length) {
        event.preventDefault(); setDraftPoints([])
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  })

  const pushChange = (next: Instance[]) => {
    setHistory((current) => [...current.slice(-49), cloneInstances(instances)])
    setFuture([])
    setInstances(next)
    setDirty(true)
    editVersionRef.current += 1
  }
  const undo = () => {
    const previous = history.at(-1)
    if (!previous) return
    setFuture((current) => [cloneInstances(instances), ...current])
    setInstances(cloneInstances(previous))
    setHistory((current) => current.slice(0, -1))
    setDirty(true)
    editVersionRef.current += 1
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setHistory((current) => [...current, cloneInstances(instances)])
    setInstances(cloneInstances(next))
    setFuture((current) => current.slice(1))
    setDirty(true)
    editVersionRef.current += 1
  }
  const removeSelected = () => {
    if (!selected.length) return
    pushChange(instances.filter((item) => !selected.includes(item.id)))
    setSelected([])
  }

  const finishDrawing = () => {
    if (draftPoints.length < 3) return
    pushChange([...instances, { id: makeId(), points: draftPoints }])
    setDraftPoints([])
    setTool('select')
  }

  const save = useCallback(async (status: 'draft' | 'reviewed', snapshot = instances) => {
    if (!frame || saving) return null
    const savingVersion = editVersionRef.current
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(
        `${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/frames/${frame.id}/annotation`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_revision: frame.revision, status, instances: snapshot }),
        },
      )
      if (!response.ok) throw new Error(await errorMessage(response, 'Save failed'))
      const saved = (await response.json()) as TrainingFrame
      setFrame(saved)
      if (editVersionRef.current === savingVersion) setDirty(false)
      return saved
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Save failed')
      return null
    } finally {
      setSaving(false)
    }
  }, [apiBase, filename, frame, instances, saving])

  useEffect(() => {
    if (!dirty || !frame || saving) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    const snapshot = cloneInstances(instances)
    saveTimerRef.current = window.setTimeout(() => { void save('draft', snapshot) }, 1000)
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current) }
  }, [dirty, frame, instances, save, saving])

  useEffect(() => {
    if (!dirty || !frame) return
    const persistDraft = () => {
      void fetch(
        `${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/frames/${frame.id}/annotation`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_revision: frame.revision, status: 'draft', instances }),
          keepalive: true,
        },
      )
    }
    window.addEventListener('pagehide', persistDraft)
    return () => window.removeEventListener('pagehide', persistDraft)
  }, [apiBase, dirty, filename, frame, instances])

  const upload = async (file: File) => {
    setUploading(true); setError(null); setUploadConflict(null); setPendingFile(file)
    try {
      const form = new FormData(); form.append('file', file)
      const response = await fetch(`${apiBase}/mother-machine/training-datasets`, { method: 'POST', body: form })
      if (response.status === 409) {
        const existing = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(file.name)}`)
        if (existing.ok) {
          const summary = (await existing.json()) as Dataset
          setUploadConflict({ filename: summary.filename, canResume: true })
        } else {
          setUploadConflict({ filename: file.name, canResume: false })
        }
        return
      }
      if (!response.ok) throw new Error(await errorMessage(response, 'Upload failed'))
      const created = (await response.json()) as Dataset
      setDataset(created)
      setSearchParams({ filename: created.filename })
      const prepare = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(created.filename)}/prepare`, { method: 'POST' })
      if (!prepare.ok) throw new Error(await errorMessage(prepare, 'Could not start ROI preparation'))
      setDataset({ ...created, status: 'preparing' })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload failed')
    } finally { setUploading(false) }
  }

  const openExisting = async (existing: Dataset | UploadConflict) => {
    if ('status' in existing && existing.status === 'paused' && existing.total_frames > 0) {
      await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(existing.filename)}/resume`, { method: 'POST' })
    }
    setSearchParams({ filename: existing.filename })
  }

  const replaceExisting = async () => {
    if (!uploadConflict || !pendingFile) return
    if (!window.confirm(`Delete the existing ${uploadConflict.filename} data and replace it?`)) return
    setUploading(true); setError(null)
    try {
      const response = await fetch(
        `${apiBase}/mother-machine/training-datasets/${encodeURIComponent(uploadConflict.filename)}`,
        { method: 'DELETE' },
      )
      if (!response.ok) throw new Error(await errorMessage(response, 'Delete failed'))
      const file = pendingFile
      setUploadConflict(null)
      await upload(file)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Replacement failed')
    } finally {
      setUploading(false)
    }
  }

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void upload(file)
    event.target.value = ''
  }

  const pointFromEvent = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / frame!.width, rect.height / frame!.height)
    const renderedWidth = frame!.width * scale
    const renderedHeight = frame!.height * scale
    const offsetX = (rect.width - renderedWidth) / 2
    const offsetY = (rect.height - renderedHeight) / 2
    return [
      Math.max(0, Math.min(frame!.width - 0.001, (event.clientX - rect.left - offsetX) / scale)),
      Math.max(0, Math.min(frame!.height - 0.001, (event.clientY - rect.top - offsetY) / scale)),
    ]
  }

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!frame) return
    const point = pointFromEvent(event)
    if (tool === 'draw') {
      setDraftPoints((current) => [...current, point])
    } else if (tool === 'split' && selected.length === 1) {
      const target = instances.find((item) => item.id === selected[0])
      if (!target) return
      const top = clipHorizontal(target.points, point[1], true)
      const bottom = clipHorizontal(target.points, point[1], false)
      if (top.length >= 3 && bottom.length >= 3) {
        pushChange([...instances.filter((item) => item.id !== target.id), { ...target, points: top }, { id: makeId(), points: bottom }])
        setSelected([]); setTool('select')
      }
    } else if (tool === 'erase') {
      setSelected([])
    }
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!frame) return
    const point = pointFromEvent(event)
    if (vertexDragRef.current) {
      setInstances((current) => current.map((item) => item.id === vertexDragRef.current!.id
        ? { ...item, points: item.points.map((old, index) => index === vertexDragRef.current!.index ? point : old) }
        : item))
      setDirty(true)
      editVersionRef.current += 1
    }
  }

  const onPointerUp = () => {
    vertexDragRef.current = null
  }

  const mergeSelected = () => {
    if (selected.length < 2) return
    const merging = instances.filter((item) => selected.includes(item.id))
    pushChange([...instances.filter((item) => !selected.includes(item.id)), { id: makeId(), points: convexHull(merging.flatMap((item) => item.points)) }])
    setSelected([])
  }

  const resetAuto = async () => {
    if (!frame) return
    setFrameInferring(true); setError(null)
    try {
      const response = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/frames/${frame.id}/infer`, { method: 'POST' })
      if (!response.ok) { setError(await errorMessage(response, 'Cellpose inference failed')); return }
      const next = (await response.json()) as TrainingFrame
      setFrame(next); setInstances(cloneInstances(next.instances)); setHistory([]); setFuture([]); setDraftPoints([]); setDirty(false); editVersionRef.current = 0
    } finally {
      setFrameInferring(false)
    }
  }

  const confirmNext = async () => {
    if (draftPoints.length) { setError('Finish or cancel the current contour first.'); return }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    const saved = await save('reviewed', cloneInstances(instances))
    if (!saved) return
    const response = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}`)
    const nextDataset = (await response.json()) as Dataset
    setDataset(nextDataset)
    if (nextDataset.status !== 'completed') await loadFrame()
  }

  const stop = async () => {
    if (draftPoints.length) { setError('Finish or cancel the current contour first.'); return }
    if (dirty) {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      const saved = await save('draft', cloneInstances(instances))
      if (!saved) return
    }
    const response = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/pause`, { method: 'POST' })
    if (!response.ok) { setError(await errorMessage(response, 'Could not pause')); return }
    navigate('/')
  }

  const progress = dataset?.total_frames ? Math.round(dataset.reviewed_count * 100 / dataset.total_frames) : 0
  const workspaceActive = Boolean(
    filename
    && dataset
    && frame
    && (dataset.status === 'annotating' || dataset.status === 'paused' || dataset.status === 'completed'),
  )

  return (
    <Box minH="100dvh" h={workspaceActive ? '100dvh' : 'auto'} overflow={workspaceActive ? 'hidden' : 'visible'} bg="sand.50" color="ink.900">
      <PageHeader actions={<><ReloadButton /><ThemeToggleButton /></>} />
      <PageContainer py={workspaceActive ? { base: 2, md: 3 } : { base: '24px', md: '30px' }} h={workspaceActive ? 'calc(100dvh - var(--app-header-height))' : 'auto'} display={workspaceActive ? 'flex' : 'block'} flexDirection="column" overflow={workspaceActive ? 'hidden' : 'visible'}>
        {!workspaceActive && <PageBreadcrumb><BreadcrumbRoot fontSize="sm" color="ink.700"><BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink as={RouterLink} to="/">Home</BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator>/</BreadcrumbSeparator>
          <BreadcrumbItem><BreadcrumbCurrentLink>Create dataset</BreadcrumbCurrentLink></BreadcrumbItem>
        </BreadcrumbList></BreadcrumbRoot></PageBreadcrumb>}

        {!filename && <Stack spacing="6" w="full">
          <Stack spacing="2"><Badge alignSelf="flex-start" colorPalette="tide">Step 1 of 4</Badge><Heading as="h1" fontSize="22px" fontWeight="600">Upload Mother Machine ND2</Heading><Text color="ink.700">One self-contained teaching database will be created for this ND2 file.</Text></Stack>
          <Flex minH="18rem" border="2px dashed" borderColor="sand.300" borderRadius="xl" bg="sand.100" align="center" justify="center" direction="column" gap="4" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void upload(file) }}>
            <Icon as={Upload} boxSize="10" color="tide.400" /><Text fontWeight="600">Drop an ND2 file here</Text><Button onClick={() => fileRef.current?.click()} loading={uploading} variant="outline">Choose ND2</Button>
          </Flex>
          <Input ref={fileRef} type="file" accept=".nd2" display="none" onChange={handleFile} />
          {uploadConflict && <Box p="4" border="1px solid" borderColor="orange.300" bg="orange.50" borderRadius="lg"><Heading size="sm">Dataset already exists</Heading><Text mt="1" fontSize="sm" color="gray.700">{uploadConflict.filename} is already registered.</Text><HStack mt="3" flexWrap="wrap">{uploadConflict.canResume && <Button onClick={() => void openExisting(uploadConflict)} variant="outline"><Icon as={Play} /> Resume existing dataset</Button>}<Button variant="outline" colorPalette="red" loading={uploading} onClick={() => void replaceExisting()}>Delete and replace</Button></HStack></Box>}
          {error && <Text color="red.500">{error}</Text>}
          {availableDatasets.length > 0 && <Stack spacing="2"><Heading size="sm">Existing teaching datasets</Heading>{availableDatasets.map((existing) => <Grid key={existing.filename} templateColumns={{ base: '1fr', md: 'minmax(0, 1fr) 180px auto' }} gap="3" alignItems="center" p="3" bg="sand.100" border="1px solid" borderColor="sand.200" borderRadius="md"><Box><Text fontWeight="600" fontSize="sm">{existing.filename}</Text><Text fontSize="xs" color="ink.700">{existing.reviewed_count} / {existing.total_frames} reviewed</Text></Box><Box><Text fontSize="xs" textAlign="right">{existing.progress_percent}% · {existing.status}</Text><Box h="1.5" bg="sand.200" borderRadius="full"><Box h="full" bg="tide.400" borderRadius="full" w={`${existing.progress_percent}%`} /></Box></Box><Button size="sm" variant="outline" onClick={() => void openExisting(existing)}><Icon as={Play} /> {existing.status === 'completed' ? 'Open' : 'Resume'}</Button></Grid>)}</Stack>}
        </Stack>}

        {filename && !dataset && <Flex minH="55vh" align="center" justify="center"><Stack textAlign="center"><Heading size="md">{error ? 'Dataset could not be loaded' : 'Loading dataset…'}</Heading>{error && <Text color="red.500">{error}</Text>}<Button variant="outline" onClick={() => navigate('/')}>Back to home</Button></Stack></Flex>}

        {filename && dataset?.status === 'preparing' && <Flex minH="55vh" align="center" justify="center"><Stack spacing="4" textAlign="center" maxW="36rem"><Badge alignSelf="center" colorPalette="tide">Step 2 of 4</Badge><Heading>Preparing ROI images</Heading><Text color="ink.700">{dataset.job?.progress?.message ?? 'Applying drift correction and extracting channel images…'}</Text><Text fontSize="sm" color="ink.700">Cellpose runs only when each ROI frame is opened.</Text><Box h="2" bg="sand.200" borderRadius="full" overflow="hidden"><Box h="full" bg="tide.400" w={`${dataset.job?.progress?.total_frames ? Math.round(100 * (dataset.job.progress.processed_frames ?? 0) / dataset.job.progress.total_frames) : 8}%`} transition="width .3s" /></Box><HStack justify="center"><Button variant="outline" onClick={() => navigate('/')}>Run in background</Button><Button variant="outline" colorPalette="orange" onClick={async () => { await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/pause`, { method: 'POST' }); navigate('/') }}><Icon as={Pause} /> Stop safely</Button></HStack></Stack></Flex>}

        {filename && dataset?.status === 'uploading' && <Flex minH="55vh" align="center" justify="center"><Stack><Heading>Dataset uploaded</Heading><Button onClick={async () => { await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/prepare`, { method: 'POST' }); setDataset({ ...dataset, status: 'preparing' }) }}>Prepare ROIs</Button></Stack></Flex>}

        {filename && dataset?.status === 'paused' && dataset.total_frames === 0 && <Flex minH="55vh" align="center" justify="center"><Stack spacing="3" maxW="36rem" textAlign="center"><Heading>ROI preparation paused</Heading><Text color="ink.700">{dataset.error || 'Preparation did not finish. You can retry without uploading the ND2 again.'}</Text><HStack justify="center"><Button variant="outline" onClick={() => navigate('/')}>Back</Button><Button onClick={async () => { const response = await fetch(`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/prepare`, { method: 'POST' }); if (!response.ok) { setError(await errorMessage(response, 'Retry failed')); return } setDataset({ ...dataset, status: 'preparing', error: null }) }} variant="outline">Retry preparation</Button></HStack></Stack></Flex>}

        {filename && dataset && (dataset.status === 'annotating' || dataset.status === 'completed' || dataset.status === 'paused') && frame && <Stack spacing="3" flex="1" minH="0" overflow="hidden">
          <Flex justify="space-between" align="center" flexWrap="wrap" gap="3">
            <Box><HStack><Badge colorPalette="tide">Step {dataset.status === 'completed' ? '4' : '3'} of 4</Badge><Badge>{dataset.status}</Badge>{dirty && <Badge colorPalette="orange">Unsaved draft</Badge>}{saving && <Badge>Saving…</Badge>}</HStack><Heading size="lg" mt="2">{dataset.filename}</Heading><Text fontSize="sm" color="ink.700">Field {frame.view_index + 1} · ROI {frame.roi_id} · Time {frame.time_frame + 1} · {instances.length} cells</Text></Box>
            <HStack><Button variant="outline" onClick={() => void stop()}><Icon as={Pause} /> Stop</Button><Button as="a" href={`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/download`} download={dataset.database} variant="outline"><Icon as={Download} /> SQLite</Button></HStack>
          </Flex>
          <Box><HStack justify="space-between" mb="1"><Text fontSize="xs">{dataset.reviewed_count} / {dataset.total_frames} reviewed</Text><Text fontSize="xs">{progress}%</Text></HStack><Box h="2" bg="sand.200" borderRadius="full"><Box h="full" bg="tide.400" borderRadius="full" w={`${progress}%`} /></Box></Box>
          {error && <Box p="3" bg="red.50" border="1px solid" borderColor="red.200" borderRadius="md"><Text color="red.700" fontSize="sm">{error}</Text></Box>}

          {dataset.status === 'completed' ? <Flex minH="0" flex="1" align="center" justify="center"><Stack textAlign="center"><Icon as={Check} boxSize="12" color="tide.400" mx="auto" /><Heading>Dataset complete</Heading><Text color="ink.700">Every ROI frame is reviewed and stored in {dataset.database}.</Text><Button as="a" href={`${apiBase}/mother-machine/training-datasets/${encodeURIComponent(filename)}/download`} download={dataset.database} variant="outline"><Icon as={Download} /> Download SQLite</Button></Stack></Flex> : <Stack spacing="3" flex="1" minH="0">
          <Flex gap="2" flexWrap="nowrap" overflowX="auto" flexShrink="0" p="2" bg="sand.100" border="1px solid" borderColor="sand.200" borderRadius="lg">
            <Button size="sm" variant={tool === 'select' ? 'solid' : 'outline'} onClick={() => { setTool('select'); setDraftPoints([]) }}><Icon as={MousePointer2} /> Select</Button>
            <Button size="sm" variant={tool === 'draw' ? 'solid' : 'outline'} onClick={() => { setTool('draw'); setSelected([]) }}><Icon as={Pencil} /> Trace</Button>
            {tool === 'draw' && draftPoints.length > 0 && <Button size="sm" colorPalette="tide" disabled={draftPoints.length < 3} onClick={finishDrawing}><Icon as={Check} /> Finish contour</Button>}
            {tool === 'draw' && draftPoints.length > 0 && <Button size="sm" variant="outline" onClick={() => setDraftPoints([])}>Cancel contour</Button>}
            <Button size="sm" variant={tool === 'erase' ? 'solid' : 'outline'} onClick={() => { setTool('erase'); setDraftPoints([]) }}><Icon as={Eraser} /> Delete cell</Button>
            <Button size="sm" variant={tool === 'split' ? 'solid' : 'outline'} disabled={selected.length !== 1} onClick={() => { setTool('split'); setDraftPoints([]) }}><Icon as={Scissors} /> Split at click</Button>
            <Button size="sm" variant="outline" disabled={selected.length < 2} onClick={mergeSelected}><Icon as={GitMerge} /> Merge</Button>
            <Button size="sm" variant="outline" disabled={!history.length} onClick={undo}><Icon as={Undo2} /></Button>
            <Button size="sm" variant="outline" disabled={!future.length} onClick={redo}><Icon as={Redo2} /></Button>
            <Button size="sm" variant="outline" loading={frameInferring} onClick={() => void resetAuto()}><Icon as={RotateCcw} /> {frame.status === 'failed' ? 'Retry Cellpose' : 'Cellpose reset'}</Button>
          </Flex>
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', xl: '120px minmax(0, 1fr) 200px' }} templateRows={{ base: 'minmax(0, 1fr) auto', xl: 'minmax(0, 1fr)' }} gap="3" alignItems="stretch" flex="1" minH="0" overflow="hidden">
            <Stack display={{ base: 'none', xl: 'flex' }} justify="center">
              <Text fontSize="xs" textAlign="center" color="ink.700">Previous</Text>{frame.previous_frame_id ? <Box as="img" src={neighborUrl(frame.previous_frame_id)} maxH="240px" w="full" objectFit="contain" bg="#05070a" opacity="0.65" /> : <Box h="160px" bg="sand.100" />}
              <Text fontSize="xs" textAlign="center" color="ink.700">Next</Text>{frame.next_frame_id ? <Box as="img" src={neighborUrl(frame.next_frame_id)} maxH="240px" w="full" objectFit="contain" bg="#05070a" opacity="0.65" /> : <Box h="160px" bg="sand.100" />}
            </Stack>
            <Flex minH="0" h="100%" bg="#05070a" borderRadius="xl" overflow="hidden" align="center" justify="center" touchAction="none" position="relative">
              {frameInferring && <Flex position="absolute" inset="0" zIndex="2" bg="blackAlpha.700" color="white" align="center" justify="center"><Stack textAlign="center"><Text fontWeight="600">Running Cellpose for this ROI frame…</Text><Text fontSize="sm" opacity="0.8">Only this image is being inferred.</Text></Stack></Flex>}
              <Box position="relative" w="94%" h="94%">
                <Box as="img" src={frameRawUrl} position="absolute" inset="0" w="100%" h="100%" objectFit="contain" draggable={false} filter={`brightness(${brightness}%) contrast(${contrast}%)`} />
                <svg ref={svgRef} viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="xMidYMid meet" width="100%" height="100%" style={{ position: 'absolute', inset: 0, cursor: tool === 'draw' ? 'crosshair' : 'default', touchAction: 'none' }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
                  {instances.map((instance, index) => <g key={instance.id}>
                    <polygon points={instance.points.map((point) => point.join(',')).join(' ')} fill={`hsla(${(index * 67) % 360}, 85%, 55%, ${opacity / 100})`} stroke={selected.includes(instance.id) ? '#fff' : `hsl(${(index * 67) % 360}, 90%, 62%)`} strokeWidth={selected.includes(instance.id) ? 1.5 : 0.65} vectorEffect="non-scaling-stroke" onPointerDown={(event) => { if (tool === 'draw') return; event.stopPropagation(); if (tool === 'erase') { pushChange(instances.filter((item) => item.id !== instance.id)); setSelected([]); return } if (tool !== 'select') return; setSelected((current) => event.shiftKey ? (current.includes(instance.id) ? current.filter((id) => id !== instance.id) : [...current, instance.id]) : [instance.id]) }} />
                    {selected.includes(instance.id) && tool === 'select' && instance.points.filter((_, pointIndex) => pointIndex % Math.max(1, Math.floor(instance.points.length / 30)) === 0).map((point) => {
                      const originalIndex = instance.points.indexOf(point)
                      return <circle key={`${instance.id}-${originalIndex}`} cx={point[0]} cy={point[1]} r={2.2} fill="white" stroke="#00AED3" strokeWidth={0.7} onPointerDown={(event) => { event.stopPropagation(); setHistory((current) => [...current.slice(-49), cloneInstances(instances)]); setFuture([]); vertexDragRef.current = { id: instance.id, index: originalIndex }; event.currentTarget.setPointerCapture(event.pointerId) }} />
                    })}
                  </g>)}
                  {draftPoints.length > 0 && <g pointerEvents="none">
                    <polyline points={draftPoints.map((point) => point.join(',')).join(' ')} fill="none" stroke="#fff" strokeWidth="1.2" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
                    {draftPoints.map((point, index) => <circle key={`draft-${index}`} cx={point[0]} cy={point[1]} r="2" fill="#00AED3" stroke="#fff" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />)}
                  </g>}
                </svg>
              </Box>
            </Flex>
            <Stack direction={{ base: 'row', xl: 'column' }} p={{ base: 2, xl: 3 }} bg="sand.100" border="1px solid" borderColor="sand.200" borderRadius="xl" spacing={{ base: 3, xl: 4 }} overflowX={{ base: 'auto', xl: 'hidden' }} overflowY={{ base: 'hidden', xl: 'auto' }} minH="0">
              <Box minW={{ base: '8rem', xl: 'auto' }}><Text fontSize="xs" fontWeight="600" mb="2">Mask opacity · {opacity}%</Text><Slider.Root min={0} max={90} value={[opacity]} onValueChange={(details) => setOpacity(details.value[0])}><Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb index={0} /></Slider.Control></Slider.Root></Box>
              <Box minW={{ base: '8rem', xl: 'auto' }}><Text fontSize="xs" fontWeight="600" mb="2">Brightness · {brightness}%</Text><Slider.Root min={25} max={250} value={[brightness]} onValueChange={(details) => setBrightness(details.value[0])}><Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb index={0} /></Slider.Control></Slider.Root></Box>
              <Box minW={{ base: '8rem', xl: 'auto' }}><Text fontSize="xs" fontWeight="600" mb="2">Contrast · {contrast}%</Text><Slider.Root min={25} max={250} value={[contrast]} onValueChange={(details) => setContrast(details.value[0])}><Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb index={0} /></Slider.Control></Slider.Root></Box>
              <Text minW={{ base: '13rem', xl: 'auto' }} fontSize="xs" color="ink.700">Trace: click points around the cell, then press Enter or Finish contour. Escape cancels.</Text>
              <Button flexShrink="0" size="lg" onClick={() => void confirmNext()} loading={saving || frameInferring} disabled={draftPoints.length > 0 || (frame.status !== 'draft' && frame.status !== 'reviewed')} variant="outline"><Icon as={Check} /> Confirm & Next</Button>
            </Stack>
          </Grid></Stack>}
        </Stack>}
      </PageContainer>
    </Box>
  )
}
