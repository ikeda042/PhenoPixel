import { useMemo, useState } from 'react'
import { Button, HStack, Icon, Text } from '@chakra-ui/react'
import { RotateCw } from 'lucide-react'
import { getApiBase } from '../utils/apiBase'

type GitPullResponse = {
  status?: string
  output?: string
  detail?: string
}

type ReloadButtonProps = {
  compact?: boolean
}

export const runGitPullUpdate = async (apiBase: string): Promise<GitPullResponse> => {
  const response = await fetch(`${apiBase}/system/git-pull`, { method: 'POST' })
  const payload = (await response.json().catch(() => ({}))) as GitPullResponse
  if (!response.ok) {
    const message =
      typeof payload.detail === 'string' && payload.detail.trim()
        ? payload.detail
        : 'Update failed.'
    throw new Error(message)
  }
  if (typeof payload.output === 'string' && payload.output.trim()) {
    console.info(payload.output)
  }
  return payload
}

const ReloadButton = ({ compact = false }: ReloadButtonProps) => {
  const apiBase = useMemo(() => getApiBase(), [])
  const [isUpdating, setIsUpdating] = useState(false)
  const buttonHeight = compact ? { base: '1.5rem', md: '1.5rem' } : { base: '1.75rem', md: '2rem' }
  const buttonMinWidth = compact
    ? { base: '1.75rem', md: '1.75rem' }
    : { base: '2.25rem', md: '2.75rem' }

  const handleUpdate = async () => {
    if (isUpdating) return
    setIsUpdating(true)
    try {
      await runGitPullUpdate(apiBase)
      window.location.reload()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error('Update failed:', error)
      window.alert(`Update failed: ${message}`)
    } finally {
      setIsUpdating(false)
    }
  }

  return (
    <Button
      type="button"
      size={compact ? 'xs' : { base: 'xs', md: 'sm' }}
      h={buttonHeight}
      minH={buttonHeight}
      maxH={buttonHeight}
      minW={buttonMinWidth}
      px={compact ? 2 : { base: 3, md: 4 }}
      py="0"
      alignSelf="center"
      lineHeight="1"
      whiteSpace="nowrap"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      border="1px solid"
      borderColor="tide.500"
      bg="tide.500"
      color="white"
      _hover={{ bg: 'tide.400' }}
      onClick={handleUpdate}
      loading={isUpdating}
      loadingText="Updating"
      aria-label="Update application"
    >
      <HStack spacing="2" align="center" justify="center">
        <Icon as={RotateCw} boxSize={compact ? 3 : 4} />
        <Text
          fontSize={compact ? '0.55rem' : 'xs'}
          letterSpacing="0.12em"
          textTransform="uppercase"
          display={{ base: 'none', md: 'inline' }}
        >
          Update
        </Text>
      </HStack>
    </Button>
  )
}

export default ReloadButton
