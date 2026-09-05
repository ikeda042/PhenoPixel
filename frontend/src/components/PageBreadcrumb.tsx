import type { ReactNode } from 'react'
import { Box } from '@chakra-ui/react'

type PageBreadcrumbProps = {
  children: ReactNode
}

const PageBreadcrumb = ({ children }: PageBreadcrumbProps) => (
  <Box className="app-breadcrumb" display="flex" justifyContent="flex-start" mb="20px" flexShrink={0}>
    {children}
  </Box>
)

export default PageBreadcrumb
