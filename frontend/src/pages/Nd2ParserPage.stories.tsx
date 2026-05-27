import type { Meta, StoryObj } from '@storybook/react'
import Nd2ParserPage from './Nd2ParserPage'

const meta: Meta<typeof Nd2ParserPage> = {
  title: 'Pages/Nd2ParserPage',
  component: Nd2ParserPage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof Nd2ParserPage>

export const Default: Story = {}
