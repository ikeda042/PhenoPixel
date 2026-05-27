import type { Meta, StoryObj } from '@storybook/react'
import FilesPage from './FilesPage'

const meta: Meta<typeof FilesPage> = {
  title: 'Pages/FilesPage',
  component: FilesPage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof FilesPage>

export const Default: Story = {}
