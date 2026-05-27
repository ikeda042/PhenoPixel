import type { Meta, StoryObj } from '@storybook/react'
import GraphEnginePage from './GraphEnginePage'

const meta: Meta<typeof GraphEnginePage> = {
  title: 'Pages/GraphEnginePage',
  component: GraphEnginePage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof GraphEnginePage>

export const Default: Story = {}
