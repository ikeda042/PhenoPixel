import type { ReactNode } from 'react'
import type { FlexProps } from '@chakra-ui/react'
import { Link } from 'react-router-dom'
import AppHeader from './AppHeader'

type PageHeaderProps = {
  actions: ReactNode
  bg?: FlexProps['bg']
}

const PageHeader = ({ actions, bg }: PageHeaderProps) => (
  <AppHeader bg={bg}>
    <Link to="/" className="app-header-brand" aria-label="PhenoPixel home">
      <img src="/favicon.png" alt="" width="23" height="23" />
      <span>PhenoPixel</span>
    </Link>
    <div className="app-header-actions">{actions}</div>
  </AppHeader>
)

export default PageHeader
