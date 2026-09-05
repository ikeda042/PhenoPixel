import type { ReactNode } from 'react'
import { Flex } from '@chakra-ui/react'
import type { FlexProps } from '@chakra-ui/react'

type AppHeaderProps = Omit<FlexProps, 'children'> & {
  children: ReactNode
}

const AppHeader = ({ children, bg = 'sand.100', ...rest }: AppHeaderProps) => (
  <Flex
    as="header"
    className="app-header"
    align="center"
    justify="space-between"
    gap="20px"
    px={{ base: '20px', md: '32px' }}
    minH="var(--app-header-height)"
    flexShrink={0}
    borderBottom="1px solid"
    borderColor="sand.200"
    bg={bg}
    position="sticky"
    top="0"
    zIndex="sticky"
    {...rest}
  >
    {children}
  </Flex>
)

export default AppHeader
