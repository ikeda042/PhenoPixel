import type { Meta, StoryObj } from '@storybook/react'
import Nd2FilesPage from './Nd2FilesPage'

const meta: Meta<typeof Nd2FilesPage> = {
  title: 'Pages/Nd2FilesPage',
  component: Nd2FilesPage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof Nd2FilesPage>

export const Default: Story = {}
