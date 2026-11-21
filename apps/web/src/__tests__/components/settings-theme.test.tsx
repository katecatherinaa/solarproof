// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '@/app/settings/page'

const setTheme = vi.fn()
let resolvedTheme = 'light'
let theme = 'system'

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme, theme, setTheme }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
}))

describe('SettingsPage theme control', () => {
  beforeEach(() => {
    resolvedTheme = 'light'
    theme = 'system'
    setTheme.mockReset()
    window.localStorage.clear()
  })

  it('defaults to system mode when no preference is stored', () => {
    render(<SettingsPage />)

    const button = screen.getByRole('button', { name: 'Switch to dark mode' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(window.localStorage.getItem('theme')).toBeNull()
  })

  it('cycles light → dark → system and calls setTheme with each mode', () => {
    theme = 'light'
    const { rerender } = render(<SettingsPage />)

    let button = screen.getByRole('button', { name: 'Switch to dark mode' })
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    expect(setTheme).toHaveBeenLastCalledWith('dark')

    theme = 'dark'
    resolvedTheme = 'dark'
    rerender(<SettingsPage />)

    button = screen.getByRole('button', { name: 'Switch to system mode' })
    expect(button.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button)
    expect(setTheme).toHaveBeenLastCalledWith('system')

    theme = 'system'
    resolvedTheme = 'light'
    rerender(<SettingsPage />)

    button = screen.getByRole('button', { name: 'Switch to light mode' })
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    expect(setTheme).toHaveBeenLastCalledWith('light')
  })

  it('switches to dark mode from system mode', () => {
    theme = 'system'
    resolvedTheme = 'light'
    render(<SettingsPage />)

    const button = screen.getByRole('button', { name: 'Switch to dark mode' })
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)

    expect(setTheme).toHaveBeenCalledWith('dark')
  })

  it('switches back to light mode when dark mode is active', () => {
    theme = 'dark'
    resolvedTheme = 'dark'
    render(<SettingsPage />)

    const button = screen.getByRole('button', { name: 'Switch to system mode' })
    expect(button.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button)

    expect(setTheme).toHaveBeenCalledWith('system')
  })
})