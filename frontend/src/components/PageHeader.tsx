import type { ReactNode } from 'react'
import { Box, Heading, HStack } from '@chakra-ui/react'
import type { FlexProps } from '@chakra-ui/react'
import { Link as RouterLink } from 'react-router-dom'
import AppHeader from './AppHeader'

type PageHeaderProps = {
  actions: ReactNode
  bg?: FlexProps['bg']
}

const PageHeader = ({ actions, bg }: PageHeaderProps) => (
  <AppHeader bg={bg}>
    <HStack
      as={RouterLink}
      to="/"
      spacing="3"
      color="inherit"
      _hover={{ textDecoration: 'none' }}
    >
      <Box
        as="img"
        src="/favicon.png"
        alt="PhenoPixel logo"
        w="1.25rem"
        h="1.25rem"
        objectFit="contain"
      />
      <Heading size="md" letterSpacing="0.08em">
        PhenoPixel
      </Heading>
    </HStack>
    <HStack spacing="4" align="center">
      {actions}
    </HStack>
  </AppHeader>
)

export default PageHeader
