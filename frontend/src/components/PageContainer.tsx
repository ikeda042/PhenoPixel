import { Container } from '@chakra-ui/react'
import type { ContainerProps } from '@chakra-ui/react'

const PageContainer = ({ children, ...props }: ContainerProps) => (
  <Container
    as="main"
    py={{ base: '24px', md: '30px' }}
    {...props}
    maxW="none"
    w="full"
    overflowWrap="anywhere"
    px={{ base: '20px', md: '32px' }}
  >
    {children}
  </Container>
)

export default PageContainer
