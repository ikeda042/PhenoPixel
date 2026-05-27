import type { Meta, StoryObj } from '@storybook/react'
import ThemeToggleButton from './ThemeToggleButton'

const meta: Meta<typeof ThemeToggleButton> = {
  title: 'Components/ThemeToggleButton',
  component: ThemeToggleButton,
}

export default meta

type Story = StoryObj<typeof ThemeToggleButton>

export const Default: Story = {}

export const Compact: Story = {
  args: {
    compact: true,
  },
}
