// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageSwitcher } from '@/components/language-switcher'

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

describe('LanguageSwitcher', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    mocks.refresh.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists the selected locale through the API before refreshing', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    render(<LanguageSwitcher current="en" />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'es' } })

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith('/api/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'es' }),
    })
    expect(screen.getByRole('status').textContent).toBe('Language changed to Español')
  })

  it('announces an API failure without refreshing', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    render(<LanguageSwitcher current="en" />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } })

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Unable to change language. Please try again.')
    )
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})