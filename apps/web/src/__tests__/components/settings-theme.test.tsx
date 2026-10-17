// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '@/app/settings/page'

const setTheme = vi.fn()
let resolvedTheme = 'light'

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme, setTheme }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
}))

describe('SettingsPage theme control', () => {
  beforeEach(() => {
    resolvedTheme = 'light'
    setTheme.mockReset()
  })

  it('exposes an accessible theme button and switches to dark mode', () => {
    render(<SettingsPage />)

    const button = screen.getByRole('button', { name: 'Switch to dark mode' })
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)

    expect(setTheme).toHaveBeenCalledWith('dark')
  })

  it('switches back to light mode when dark mode is active', () => {
    resolvedTheme = 'dark'
    render(<SettingsPage />)

    const button = screen.getByRole('button', { name: 'Switch to light mode' })
    expect(button.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button)

    expect(setTheme).toHaveBeenCalledWith('light')
  })
})