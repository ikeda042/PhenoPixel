import type { Meta, StoryObj } from '@storybook/react'
import CellExtractionPage from './CellExtractionPage'

const meta: Meta<typeof CellExtractionPage> = {
  title: 'Pages/CellExtractionPage',
  component: CellExtractionPage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof CellExtractionPage>

export const Default: Story = {}
