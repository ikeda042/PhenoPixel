import type { Meta, StoryObj } from '@storybook/react'
import AnnotationPage from './AnnotationPage'

const meta: Meta<typeof AnnotationPage> = {
  title: 'Pages/AnnotationPage',
  component: AnnotationPage,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta

type Story = StoryObj<typeof AnnotationPage>

export const Default: Story = {}
