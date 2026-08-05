import type { ReactNode } from 'react'
import { Flex, Icon, IconButton } from '@chakra-ui/react'
import type { FlexProps } from '@chakra-ui/react'
import { Github } from 'lucide-react'

type AppHeaderProps = Omit<FlexProps, 'children'> & {
  children: ReactNode
  bg?: FlexProps['bg']
}

const AppHeader = ({ children, bg = 'sand.50/85', ...rest }: AppHeaderProps) => (
  <Flex
    as="header"
    align="center"
    px={{ base: 4, md: 8 }}
    h="4rem"
    borderBottom="1px solid"
    borderColor="sand.200"
    bg={bg}
    backdropFilter="blur(0.75rem)"
    position="sticky"
    top="0"
    zIndex="sticky"
    {...rest}
  >
    <Flex
      align="center"
      justify="space-between"
      flex="1"
      minW="0"
      gap={{ base: 3, md: 4 }}
      sx={{
        '& > *': { minW: 0 },
        '& > *:last-child': {
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
        },
        '& button': {
          flexShrink: 0,
          alignSelf: 'center',
        },
      }}
    >
      {children}
    </Flex>
    <IconButton
      as="a"
      href="https://github.com/ikeda042/PhenoPixel"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open PhenoPixel GitHub repository"
      size={{ base: 'xs', md: 'sm' }}
      h={{ base: '1.75rem', md: '2rem' }}
      minW={{ base: '1.75rem', md: '2rem' }}
      ms={{ base: 2, md: 3 }}
      border="1px solid"
      borderColor="sand.200"
      bg="sand.100"
      color="ink.700"
      _hover={{ bg: 'sand.200', color: 'ink.900' }}
      flexShrink={0}
    >
      <Icon as={Github} boxSize={{ base: 3, md: 4 }} />
    </IconButton>
  </Flex>
)

export default AppHeader
