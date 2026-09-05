import { useMemo, useState } from 'react'
import { Button, HStack, Icon, Text } from '@chakra-ui/react'
import { RotateCw } from 'lucide-react'
import { getApiBase } from '../utils/apiBase'
import { runGitPullUpdate } from '../utils/appUpdate'

type ReloadButtonProps = {
  compact?: boolean
}

const ReloadButton = ({ compact = false }: ReloadButtonProps) => {
  const apiBase = useMemo(() => getApiBase(), [])
  const [isUpdating, setIsUpdating] = useState(false)
  const buttonHeight = compact ? '28px' : '30px'
  const buttonMinWidth = buttonHeight

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
      px="9px"
      py="0"
      alignSelf="center"
      lineHeight="1"
      whiteSpace="nowrap"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      border="1px solid"
      borderColor="sand.200"
      bg="sand.50"
      color="ink.900"
      _hover={{ bg: 'sand.100' }}
      onClick={handleUpdate}
      loading={isUpdating}
      loadingText="Updating"
      aria-label="Update application"
    >
      <HStack gap="6px" align="center" justify="center">
        <Icon as={RotateCw} boxSize="14px" />
        <Text
          fontSize="11px"
          display={{ base: 'none', md: 'inline' }}
        >
          Update
        </Text>
      </HStack>
    </Button>
  )
}

export default ReloadButton
