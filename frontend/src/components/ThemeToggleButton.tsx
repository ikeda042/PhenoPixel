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
  const buttonHeight = compact ? { base: '1.5rem', md: '1.5rem' } : { base: '1.75rem', md: '2rem' }
  const buttonMinWidth = compact
    ? { base: '1.75rem', md: '1.75rem' }
    : { base: '2.25rem', md: '2.75rem' }

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
      onClick={handleToggle}
      aria-label={`Switch to ${label} mode`}
    >
      <HStack spacing="2" align="center" justify="center">
        <Icon as={ModeIcon} boxSize={compact ? 3 : 4} />
        <Text
          fontSize={compact ? '0.55rem' : 'xs'}
          letterSpacing="0.12em"
          textTransform="uppercase"
          display={{ base: 'none', md: 'inline' }}
        >
          {label}
        </Text>
      </HStack>
    </Button>
  )
}

export default ThemeToggleButton
