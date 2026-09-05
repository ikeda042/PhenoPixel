import { useState } from 'react'
import { Button, HStack, Icon, Text } from '@chakra-ui/react'
import { Moon, Sun } from 'lucide-react'

const THEME_STORAGE_KEY = 'phenopixel-theme'

type ThemeMode = 'dark' | 'light'

const getCurrentMode = (): ThemeMode => {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

type ThemeToggleButtonProps = {
  compact?: boolean
}

const ThemeToggleButton = ({ compact = false }: ThemeToggleButtonProps) => {
  const [mode, setMode] = useState<ThemeMode>(() => getCurrentMode())
  const buttonHeight = compact ? '28px' : '30px'
  const buttonMinWidth = buttonHeight

  const handleToggle = () => {
    const nextMode: ThemeMode = mode === 'dark' ? 'light' : 'dark'
    const root = document.documentElement
    root.classList.toggle('dark', nextMode === 'dark')
    root.classList.toggle('light', nextMode === 'light')
    window.localStorage.setItem(THEME_STORAGE_KEY, nextMode)
    setMode(nextMode)
  }

  const targetMode: ThemeMode = mode === 'dark' ? 'light' : 'dark'
  const label = targetMode === 'dark' ? 'Dark' : 'Light'
  const ModeIcon = targetMode === 'dark' ? Moon : Sun

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
      onClick={handleToggle}
      aria-label={`Switch to ${label} mode`}
    >
      <HStack gap="6px" align="center" justify="center">
        <Icon as={ModeIcon} boxSize="14px" />
        <Text
          fontSize="11px"
          display={{ base: 'none', md: 'inline' }}
        >
          {label}
        </Text>
      </HStack>
    </Button>
  )
}

export default ThemeToggleButton
