import type { Meta, StoryObj } from '@storybook/react'
import { Badge, HStack, Text } from '@chakra-ui/react'
import AppHeader from './AppHeader'
import ReloadButton from './ReloadButton'
import ThemeToggleButton from './ThemeToggleButton'

const meta: Meta<typeof AppHeader> = {
  title: 'Components/AppHeader',
  component: AppHeader,
}

export default meta

type Story = StoryObj<typeof AppHeader>

export const Default: Story = {
  render: () => (
    <AppHeader>
      <HStack spacing="3">
        <Text fontWeight="600">PhenoPixel</Text>
        <Badge colorScheme="green">Online</Badge>
      </HStack>
      <HStack spacing="2">
        <ReloadButton compact />
        <ThemeToggleButton compact />
      </HStack>
    </AppHeader>
  ),
}
