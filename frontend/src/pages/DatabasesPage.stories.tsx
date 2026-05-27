import type { Meta, StoryObj } from '@storybook/react'
import DatabasesPage from './DatabasesPage'

const meta: Meta<typeof DatabasesPage> = {
  title: 'Pages/DatabasesPage',
  component: DatabasesPage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof DatabasesPage>

export const Default: Story = {}
