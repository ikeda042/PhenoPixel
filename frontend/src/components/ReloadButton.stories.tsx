import type { Meta, StoryObj } from '@storybook/react'
import ReloadButton from './ReloadButton'

const meta: Meta<typeof ReloadButton> = {
  title: 'Components/ReloadButton',
  component: ReloadButton,
}

export default meta

type Story = StoryObj<typeof ReloadButton>

export const Default: Story = {}

export const Compact: Story = {
  args: {
    compact: true,
  },
}
