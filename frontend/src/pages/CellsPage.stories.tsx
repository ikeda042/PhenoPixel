import type { Meta, StoryObj } from '@storybook/react'
import CellsPage from './CellsPage'

const meta: Meta<typeof CellsPage> = {
  title: 'Pages/CellsPage',
  component: CellsPage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof CellsPage>

export const Default: Story = {}
