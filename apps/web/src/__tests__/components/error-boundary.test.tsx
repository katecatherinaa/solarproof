// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '@/components/error-boundary'

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }))

vi.mock('@sentry/nextjs', () => ({
  captureException: mocks.captureException,
}))

let shouldThrow = true

function TestSection() {
  if (shouldThrow) throw new Error('section failed')
  return <p>Section recovered</p>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true
    mocks.captureException.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('shows a scoped retry fallback and reports the error to Sentry', () => {
    render(
      <ErrorBoundary inline label="Certificate table">
        <TestSection />
      </ErrorBoundary>
    )

    expect(screen.getByRole('alert').textContent).toContain('Certificate table failed to load.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(mocks.captureException).toHaveBeenCalledOnce()
    expect(mocks.captureException.mock.calls[0][0].message).toBe('section failed')
  })

  it('retries rendering its section', () => {
    render(
      <ErrorBoundary inline label="Meter list">
        <TestSection />
      </ErrorBoundary>
    )

    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(screen.getByText('Section recovered')).toBeTruthy()
  })
})