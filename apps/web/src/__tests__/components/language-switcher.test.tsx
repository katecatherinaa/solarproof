// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageSwitcher } from '@/components/language-switcher'

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), t: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

describe('LanguageSwitcher', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    mocks.refresh.mockReset()
    mocks.t.mockReset()
    mocks.t.mockImplementation((key: string) => key)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reflects the active locale in the select', () => {
    render(<LanguageSwitcher current="fr" />)

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('fr')
  })

  it('persists the selected locale through the API before refreshing', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    mocks.t.mockImplementation((key: string, options?: { language?: string }) =>
      key === 'languageSwitcher.success' ? `Language changed to ${options?.language}` : key
    )
    render(<LanguageSwitcher current="en" />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'es' } })

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith('/api/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'es' }),
    })
    expect(mocks.t).toHaveBeenCalledWith('languageSwitcher.success', { language: 'Español' })
    expect(screen.getByRole('status').textContent).toBe('Language changed to Español')
  })

  it('renders and persists the Portuguese (Brazil) locale', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    render(<LanguageSwitcher current="en" />)

    const option = screen.getByRole('option', { name: 'Português (BR)' })
    expect((option as HTMLOptionElement).value).toBe('pt-BR')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pt-BR' } })

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith('/api/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'pt-BR' }),
    })
    expect(screen.getByRole('status').textContent).toBe('Language changed to Português (BR)')
  })

  it('announces an API failure without refreshing', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    mocks.t.mockImplementation((key: string) =>
      key === 'languageSwitcher.error' ? 'Unable to change language. Please try again.' : key
    )
    render(<LanguageSwitcher current="en" />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } })

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Unable to change language. Please try again.')
    )
    expect(mocks.t).toHaveBeenCalledWith('languageSwitcher.error')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('keeps the layout intact when rendered in an RTL document', () => {
    document.documentElement.setAttribute('dir', 'rtl')
    document.documentElement.setAttribute('lang', 'ar')

    try {
      const { container } = render(<LanguageSwitcher current="ar" />)

      expect(document.documentElement.getAttribute('dir')).toBe('rtl')
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('ar')
      expect(container.firstElementChild).not.toBeNull()
      expect(container.querySelector('[dir="ltr"]')).toBeNull()
    } finally {
      document.documentElement.removeAttribute('dir')
      document.documentElement.removeAttribute('lang')
    }
  })
})