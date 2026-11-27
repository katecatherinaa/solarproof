import type { Meta, StoryObj } from '@storybook/react';
import { DashboardChart } from './DashboardChart';

const meta: Meta<typeof DashboardChart> = {
  title: 'Components/DashboardChart',
  component: DashboardChart,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    data: { control: 'object' },
    loading: { control: 'boolean' },
    error: { control: 'text' },
  },
};

export default meta;

type Story = StoryObj<typeof DashboardChart>;

const sampleData = [
  { label: 'Jan', value: 120 },
  { label: 'Feb', value: 200 },
  { label: 'Mar', value: 150 },
  { label: 'Apr', value: 300 },
  { label: 'May', value: 250 },
  { label: 'Jun', value: 400 },
];

export const Default: Story = {
  args: {
    data: sampleData,
  },
};

export const Loading: Story = {
  args: {
    data: [],
    loading: true,
  },
};

export const Error: Story = {
  args: {
    data: [],
    error: 'Failed to load chart data. Please try again.',
  },
};

export const Empty: Story = {
  args: {
    data: [],
  },
};

export const SingleDataPoint: Story = {
  args: {
    data: [{ label: 'Jan', value: 120 }],
  },
};

export const LargeDataset: Story = {
  args: {
    data: Array.from({ length: 24 }, (_, i) => ({
      label: `M${i + 1}`,
      value: Math.floor(Math.random() * 500) + 50,
    })),
  },
};