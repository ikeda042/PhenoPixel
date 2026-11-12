import { useEffect, useRef, useState } from 'react'
import { Box, Button, HStack, Input, NativeSelect, Spinner, Text } from '@chakra-ui/react'

export type SpotOptions = {
  channel: 'fluo1' | 'fluo2'
  autoTune: boolean
  sigmaMin: string
  sigmaMax: string
  minSnr: string
}

type EmeansPanelProps = {
  apiBase: string
  dbName: string
  cellId: string
  clusters: string
  onClustersChange: (value: string) => void
  spotMode: boolean
  spotOptions: SpotOptions
  onSpotOptionsChange: (value: SpotOptions) => void
}

const MAX_CLUSTERS = 64

export default function EmeansPanel({ apiBase, dbName, cellId, clusters, onClustersChange,
  spotMode, spotOptions, onSpotOptionsChange }: EmeansPanelProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const imageUrlRef = useRef<string | null>(null)
  const count = Number(clusters)
  const maximumCount = spotMode ? 16 : MAX_CLUSTERS
  const isCountValid = clusters.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= maximumCount
  const sigmaMin = Number(spotOptions.sigmaMin)
  const sigmaMax = Number(spotOptions.sigmaMax)
  const minSnr = Number(spotOptions.minSnr)
  const isWidthValid = spotOptions.sigmaMin.trim() !== '' && spotOptions.sigmaMax.trim() !== '' &&
    Number.isFinite(sigmaMin) && Number.isFinite(sigmaMax) && sigmaMin >= 0.5 && sigmaMin < sigmaMax && sigmaMax <= 10
  const isSnrValid = spotOptions.minSnr.trim() !== '' && Number.isFinite(minSnr) && minSnr >= 2 && minSnr <= 30
  const isValid = isCountValid && (!spotMode || spotOptions.autoTune || (isWidthValid && isSnrValid))

  useEffect(() => () => {
    controllerRef.current?.abort()
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
  }, [])

  const clearResult = () => {
    controllerRef.current?.abort()
    controllerRef.current = null
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
    imageUrlRef.current = null
    setImageUrl(null)
    setError(null)
    setIsLoading(false)
  }

  const calculate = async () => {
    if (!isValid || !dbName || !cellId || isLoading) return
    clearResult()
    const controller = new AbortController()
    controllerRef.current = controller
    setIsLoading(true)
    try {
      const params = new URLSearchParams({
        dbname: dbName, cell_id: cellId, dark_mode: 'true',
      })
      if (spotMode) {
        params.set('channel', spotOptions.channel)
        params.set('max_spots', String(count))
        params.set('auto_tune', String(spotOptions.autoTune))
        if (!spotOptions.autoTune) {
          params.set('sigma_min', String(sigmaMin))
          params.set('sigma_max', String(sigmaMax))
          params.set('min_snr', String(minSnr))
        }
      } else {
        params.set('n_clusters', String(count))
      }
      const endpoint = spotMode ? 'get-cell-e-means-spots' : 'get-cell-e-means'
      const response = await fetch(`${apiBase}/${endpoint}?${params}`, {
        headers: { accept: 'image/png' }, signal: controller.signal,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { detail?: unknown } | null
        throw new Error(typeof payload?.detail === 'string'
          ? payload.detail : `e-means calculation failed (${response.status})`)
      }
      const blob = await response.blob()
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob)
      imageUrlRef.current = url
      setImageUrl(url)
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : 'e-means calculation failed')
      }
    } finally {
      if (!controller.signal.aborted) setIsLoading(false)
    }
  }

  return (
    <>
      <HStack gap="2" flexWrap="wrap">
        {spotMode && <NativeSelect.Root size="sm" w="6rem">
          <NativeSelect.Field aria-label="Spot channel" value={spotOptions.channel}
            onChange={(event) => {
              clearResult()
              onSpotOptionsChange({ ...spotOptions, channel: event.target.value as SpotOptions['channel'] })
            }} bg="sand.50">
            <option value="fluo1">FLUO1</option>
            <option value="fluo2">FLUO2</option>
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>}
        {spotMode && <NativeSelect.Root size="sm" w="7rem">
          <NativeSelect.Field aria-label="Spot tuning" value={spotOptions.autoTune ? 'auto' : 'manual'}
            onChange={(event) => {
              clearResult()
              onSpotOptionsChange({ ...spotOptions, autoTune: event.target.value === 'auto' })
            }} bg="sand.50">
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>}
        <Text as="label" htmlFor="e-means-clusters" fontSize="xs" color="ink.700">
          {spotMode ? 'Max spots' : 'Clusters'}
        </Text>
        <Input
          id="e-means-clusters" type="number" min={1} max={maximumCount} step={1}
          size="sm" w="5rem" bg="sand.50" value={clusters} aria-invalid={!isCountValid}
          aria-describedby="e-means-clusters-hint"
          onChange={(event) => { clearResult(); onClustersChange(event.target.value) }}
        />
        <Button size="sm" variant="outline" onClick={() => void calculate()}
          loading={isLoading} loadingText="Calculating..."
          disabled={!isValid || !dbName || !cellId || isLoading}>
          Calc
        </Button>
        <Text id="e-means-clusters-hint" fontSize="xs" color="ink.700">
          1–{maximumCount}
        </Text>
      </HStack>
      {spotMode && spotOptions.autoTune && <Text fontSize="xs" color="ink.700">
        Auto estimates widths and acceptance thresholds for this cell. Selected values appear in the plot.
        {' '}Max spots is a limit; zero spots is a valid result.
      </Text>}
      {spotMode && !spotOptions.autoTune && <>
        <HStack gap="2" flexWrap="wrap">
          {([
            ['sigmaMin', 'Min σ', 0.5, 10, isWidthValid],
            ['sigmaMax', 'Max σ', 0.5, 10, isWidthValid],
            ['minSnr', 'Min SNR', 2, 30, isSnrValid],
          ] as const).map(([field, label, min, max, valid]) => <HStack key={field} gap="1">
            <Text as="label" htmlFor={`spot-${field}`} fontSize="xs" color="ink.700">{label}</Text>
            <Input id={`spot-${field}`} type="number" min={min} max={max} step="0.1"
              size="sm" w="4.5rem" bg="sand.50" value={spotOptions[field]} aria-invalid={!valid}
              aria-describedby="spot-width-help"
              onChange={(event) => {
                clearResult()
                onSpotOptionsChange({ ...spotOptions, [field]: event.target.value })
              }} />
          </HStack>)}
        </HStack>
        <Text id="spot-width-help" fontSize="xs" color="ink.700">
          σ: Gaussian width in px (FWHM = 2.355σ). Zero spots is a valid result.
        </Text>
      </>}
      <Box bg="sand.200" borderRadius="lg" overflow="hidden" flex="1"
        minH={{ base: '11rem', lg: 'clamp(9rem, 30vh, 22rem)' }}
        display="flex" alignItems="center" justifyContent="center">
        {isLoading ? (
          <HStack role="status" p="3"><Spinner size="sm" /><Text fontSize="sm">Calculating e-means...</Text></HStack>
        ) : imageUrl ? (
          <Box as="img" src={imageUrl} alt={`${cellId} e-means ${spotMode ? 'spots' : 'clustering'}`}
            width="100%" height="100%" objectFit="contain" />
        ) : (
          <Text fontSize="sm" color="ink.700" p="3">
            {spotMode ? (spotOptions.autoTune ? 'Choose a channel and press Calc.' : 'Set spot parameters and press Calc.')
              : 'Choose clusters and press Calc.'}
          </Text>
        )}
      </Box>
      {error && <Text role="alert" fontSize="sm" color="violet.300">{error}</Text>}
    </>
  )
}
