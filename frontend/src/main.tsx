import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import '@fontsource/noto-sans-jp/400.css'
import '@fontsource/noto-sans-jp/600.css'
import '@fontsource/noto-sans-jp/700.css'
import './index.css'
import AnnotationPage from './pages/AnnotationPage'
import BulkEnginePage from './pages/BulkEnginePage'
import CellExtractionPage from './pages/CellExtractionPage'
import CellsPage from './pages/CellsPage'
import DatabasesPage from './pages/DatabasesPage'
import FilesPage from './pages/FilesPage'
import GraphEnginePage from './pages/GraphEnginePage'
import Nd2ParserPage from './pages/Nd2ParserPage'
import Nd2FilesPage from './pages/Nd2FilesPage'
import MotherMachineCellExtractionPage from './pages/MotherMachineCellExtractionPage'
import MotherMachineDatabasesPage from './pages/MotherMachineDatabasesPage'
import MotherMachineNd2FilesPage from './pages/MotherMachineNd2FilesPage'
import TopPage from './pages/TopPage'
import system from './theme'

const THEME_STORAGE_KEY = 'phenopixel-theme'
const root = document.documentElement
const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
const resolvedTheme =
  storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : 'light'

root.classList.toggle('dark', resolvedTheme === 'dark')
root.classList.toggle('light', resolvedTheme === 'light')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChakraProvider value={system}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<TopPage />} />
          <Route path="/annotation" element={<AnnotationPage />} />
          <Route path="/bulk-engine" element={<BulkEnginePage />} />
          <Route path="/cell-extraction" element={<CellExtractionPage />} />
          <Route path="/cells" element={<CellsPage />} />
          <Route path="/databases" element={<DatabasesPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/graph-engine" element={<GraphEnginePage />} />
          <Route path="/nd2files" element={<Nd2FilesPage />} />
          <Route path="/nd2parser" element={<Nd2ParserPage />} />
          <Route path="/mother-machine" element={<Navigate to="/mother-machine/nd2files" replace />} />
          <Route path="/mother-machine/" element={<Navigate to="/mother-machine/nd2files" replace />} />
          <Route path="/mother-machine/nd2files" element={<MotherMachineNd2FilesPage />} />
          <Route path="/mother-machine/cell-extraction" element={<MotherMachineCellExtractionPage />} />
          <Route path="/mother-machine/databases" element={<MotherMachineDatabasesPage />} />
        </Routes>
      </BrowserRouter>
    </ChakraProvider>
  </StrictMode>,
)
