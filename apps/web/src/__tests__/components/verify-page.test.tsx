/**
 * Snapshot/regression tests for the verify page
 * Issue #594 — catch unintended visual regressions across all states
 *
 * To update snapshots after intentional changes:
 *   pnpm test -- --update-snapshots
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import VerifyPage from '@/app/verify/page'

const mockSearchParams = new URLSearchParams()
const mockReplace = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}))

vi.mock('lucide-react', () => ({
  Shield: (props: Record<string, unknown>) => <span data-icon="Shield" {...props} />,
  Search: (props: Record<string, unknown>) => <span data-icon="Search" {...props} />,
  CheckCircle: (props: Record<string, unknown>) => <span data-icon="CheckCircle" {...props} />,
  XCircle: (props: Record<string, unknown>) => <span data-icon="XCircle" {...props} />,
  ExternalLink: (props: Record<string, unknown>) => <span data-icon="ExternalLink" {...props} />,
}))

vi.mock('@/components/skeleton', () => ({
  SectionSkeleton: ({ rows }: { rows?: number }) => (
    <div data-testid="section-skeleton" data-rows={rows} />
  ),
}))

const mockChainOfCustody = {
  certificate: {
    id: 'cert-abc-123',
    kwh: 12.5,
    issued_at: '2024-01-15T10:00:00.000Z',
    retired: false,
    retired_at: null,
    retired_by: null,
  },
  on_chain: {
    anchor_tx: 'anchor-tx-hash-abc',
    anchor_explorer: 'https://stellar.expert/anchor-tx-hash-abc',
    mint_tx: 'mint-tx-hash-def',
    mint_explorer: 'https://stellar.expert/mint-tx-hash-def',
  },
  meter_proof: {
    meter_id: 'meter-xyz-456',
    reading_hash: 'abcdef1234567890abcdef1234567890',
    signature_hex: 'sig1234567890abcdef1234567890abc',
    kwh: 12.5,
    timestamp: '2024-01-15T09:55:00.000Z',
    verified: true,
  },
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockReplace.mockClear()
  for (const key of Array.from(mockSearchParams.keys())) {
    mockSearchParams.delete(key)
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('VerifyPage snapshots', () => {
  it('renders idle state', () => {
    const { container } = render(<VerifyPage />)
    expect(container).toMatchSnapshot()
  })

  it('renders search form with correct accessibility attributes', () => {
    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    expect(input.getAttribute('aria-label')).toBe('Certificate ID, reading hash, or transaction hash')
    expect(input.getAttribute('aria-required')).toBe('true')

    const button = screen.getByRole('button', { name: /verify certificate/i })
    expect(button.getAttribute('aria-label')).toBe('Verify certificate')
    expect(button.getAttribute('aria-busy')).toBe('false')
  })

  it('renders error state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Not found' }),
    }))

    const { container } = render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'bad-id' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('alert'))
    expect(container).toMatchSnapshot()
  })

  it('renders success result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    }))

    const { container } = render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'cert-abc-123' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('status'))
    expect(container).toMatchSnapshot()
  })
})

describe('VerifyPage tx hash lookup', () => {
  const TX_HASH = 'a'.repeat(64)

  it('auto-resolves a certificate from ?tx=<64-hex> on mount', async () => {
    mockSearchParams.set('tx', TX_HASH)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VerifyPage />)

    await waitFor(() => screen.getByRole('status'))
    expect(fetchMock).toHaveBeenCalled()
    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain(TX_HASH)
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe(TX_HASH)
  })

  it('shows a not-found message for an unknown tx hash', async () => {
    mockSearchParams.set('tx', TX_HASH)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Not found' }),
    }))

    render(<VerifyPage />)

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toMatch(/not found/i)
  })

  it('accepts a UUID in the search input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'cert-abc-123' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('status'))
    expect(fetchMock).toHaveBeenCalled()
  })

  it('accepts a 64-char hex tx hash in the search input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: TX_HASH } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('status'))
    expect(fetchMock).toHaveBeenCalled()
    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain(TX_HASH)
  })

  it('rejects malformed input without issuing a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'not-a-valid-id' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('alert'))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('VerifyPage kiosk mode', () => {
  beforeEach(() => {
    mockSearchParams.set('kiosk', '1')
  })

  it('renders the kiosk layout when ?kiosk=1 is present', () => {
    render(<VerifyPage />)
    expect(screen.getByTestId('kiosk-container')).toBeTruthy()
    expect(screen.getByRole('region', { name: /kiosk/i })).toBeTruthy()
  })

  it('does not render the kiosk layout without the kiosk param', () => {
    mockSearchParams.delete('kiosk')
    render(<VerifyPage />)
    expect(screen.queryByTestId('kiosk-container')).toBeNull()
  })

  it('auto-resets to the home state after 60s of inactivity', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    }))

    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'cert-abc-123' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('status'))

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    expect(mockReplace).toHaveBeenCalledWith('/verify?kiosk=1')
  })

  it('does not reset before 60s of inactivity', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    }))

    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'cert-abc-123' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('status'))

    await act(async () => {
      vi.advanceTimersByTime(59_000)
    })

    expect(screen.getByRole('status')).toBeTruthy()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('resets the inactivity timer on pointer interaction', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    }))

    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'cert-abc-123' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('status'))

    await act(async () => {
      vi.advanceTimersByTime(50_000)
    })

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('kiosk-container'))
    })

    await act(async () => {
      vi.advanceTimersByTime(50_000)
    })

    // 100s total elapsed, but timer was reset at 50s, so still active
    expect(screen.getByRole('status')).toBeTruthy()
    expect(mockReplace).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(mockReplace).toHaveBeenCalledWith('/verify?kiosk=1')
  })

  it('resets the inactivity timer on keyboard interaction', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChainOfCustody,
    }))

    render(<VerifyPage />)
    const input = screen.getByRole('searchbox')
    const button = screen.getByRole('button', { name: /verify certificate/i })

    fireEvent.change(input, { target: { value: 'cert-abc-123' } })
    await act(async () => { fireEvent.click(button) })

    await waitFor(() => screen.getByRole('status'))

    await act(async () => {
      vi.advanceTimersByTime(50_000)
    })

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('kiosk-container'), { key: 'Tab' })
    })

    await act(async () => {
      vi.advanceTimersByTime(50_000)
    })

    expect(screen.getByRole('status')).toBeTruthy()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
