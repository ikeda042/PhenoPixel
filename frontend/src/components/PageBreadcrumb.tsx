import type { ReactNode } from 'react'
import { Box } from '@chakra-ui/react'

type PageBreadcrumbProps = {
  children: ReactNode
}

const PageBreadcrumb = ({ children }: PageBreadcrumbProps) => (
  <Box display="flex" justifyContent="flex-start" mb={{ base: 4, md: 6 }}>
    {children}
  </Box>
)

export default PageBreadcrumb
