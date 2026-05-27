import type { Meta, StoryObj } from '@storybook/react'
import BulkEnginePage from './BulkEnginePage'

const meta: Meta<typeof BulkEnginePage> = {
  title: 'Pages/BulkEnginePage',
  component: BulkEnginePage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof BulkEnginePage>

export const Default: Story = {}
