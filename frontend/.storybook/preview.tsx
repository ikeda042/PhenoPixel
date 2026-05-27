import { ChakraProvider } from '@chakra-ui/react'
import type { FC } from 'react'
import { MemoryRouter } from 'react-router-dom'
import '@fontsource/noto-sans-jp/400.css'
import '@fontsource/noto-sans-jp/600.css'
import '@fontsource/noto-sans-jp/700.css'
import '../src/index.css'
import system from '../src/theme'

if (typeof document !== 'undefined') {
  const root = document.documentElement
  root.classList.add('light')
  root.classList.remove('dark')
}

const preview = {
  parameters: {
    actions: { argTypesRegex: '^on[A-Z].*' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
  },
  decorators: [
    (Story: FC) => (
      <ChakraProvider value={system}>
        <MemoryRouter>
          <Story />
        </MemoryRouter>
      </ChakraProvider>
    ),
  ],
}

export default preview
