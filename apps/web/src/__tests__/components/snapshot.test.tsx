/**
 * Snapshot tests for key UI components
 * Issue #328 — catch unintended visual regressions
 */
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import {
  Skeleton,
  StatCardSkeleton,
  ChartSkeleton,
  TableRowSkeleton,
  SectionSkeleton,
  ProposalCardSkeleton,
  ProposalListSkeleton,
} from '@/components/skeleton'
import { MeterReadingRow } from '@/components/meter-reading-row'
import { CopyButton, CopyableText } from '@/components/copy-button'
import { LanguageSwitcher } from '@/components/language-switcher'
import { ToastProvider, ToastContainer } from '@/components/toast'
import { Navbar } from '@/components/navbar'
import {
  DashboardEmptyState,
  CertificatesEmptyState,
  MetersEmptyState,
  GovernanceEmptyState,
} from '@/components/empty-states'
import React from 'react'

// Mocks
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useTransition: () => [false, vi.fn()],
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({
    resolvedTheme: 'light',
    setTheme: vi.fn(),
  }),
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    address: 'GABC...XYZ',
    connected: true,
    loading: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}))

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
  },
}))

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

// Mock lucide-react to avoid random IDs in snapshots
vi.mock('lucide-react', async () => {
  const actual = await vi.importActual('lucide-react')
  return {
    ...actual,
    Sun: () => <div data-testid="sun-icon" />,
    Moon: () => <div data-testid="moon-icon" />,
    Menu: () => <div data-testid="menu-icon" />,
    X: () => <div data-testid="x-icon" />,
    Wallet: () => <div data-testid="wallet-icon" />,
    LogOut: () => <div data-testid="logout-icon" />,
    Copy: () => <div data-testid="copy-icon" />,
    Check: () => <div data-testid="check-icon" />,
    CheckCircle: () => <div data-testid="check-circle-icon" />,
    XCircle: () => <div data-testid="x-circle-icon" />,
    Loader2: () => <div data-testid="loader-icon" />,
  }
})

describe('Skeleton components snapshots', () => {
  it('Skeleton renders correctly', () => {
    const { container } = render(<Skeleton />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('Skeleton with custom className renders correctly', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('StatCardSkeleton renders correctly', () => {
    const { container } = render(<StatCardSkeleton />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('ChartSkeleton renders correctly (no title)', () => {
    const { container } = render(<ChartSkeleton />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('ChartSkeleton renders correctly (with title)', () => {
    const { container } = render(<ChartSkeleton title="Daily energy output" />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('TableRowSkeleton renders correctly (default 4 cols)', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRowSkeleton />
        </tbody>
      </table>
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('TableRowSkeleton renders correctly (2 cols)', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRowSkeleton cols={2} />
        </tbody>
      </table>
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('SectionSkeleton renders correctly (default 4 rows)', () => {
    const { container } = render(<SectionSkeleton />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('SectionSkeleton renders correctly (2 rows)', () => {
    const { container } = render(<SectionSkeleton rows={2} />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('ProposalCardSkeleton renders correctly', () => {
    const { container } = render(<ProposalCardSkeleton />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('ProposalListSkeleton renders correctly', () => {
    const { container } = render(<ProposalListSkeleton count={2} />)
    expect(container.firstChild).toMatchSnapshot()
  })
})

describe('MeterReadingRow snapshots', () => {
  const base = {
    id: 'row-1',
    meter_id: 'meter-abc-123',
    kwh: 12.5,
    timestamp: '2024-01-15T10:30:00.000Z',
  }

  it('verified reading row renders correctly', () => {
    const { container } = render(
      <table>
        <tbody>
          <MeterReadingRow {...base} verified={true} />
        </tbody>
      </table>
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('pending (unverified) reading row renders correctly', () => {
    const { container } = render(
      <table>
        <tbody>
          <MeterReadingRow {...base} verified={false} />
        </tbody>
      </table>
    )
    expect(container.firstChild).toMatchSnapshot()
  })
})

describe('Copy components snapshots', () => {
  it('CopyButton renders correctly', () => {
    const { container } = render(<CopyButton value="test-value" />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('CopyableText renders correctly (mono)', () => {
    const { container } = render(<CopyableText value="0x1234567890" />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('CopyableText renders correctly (non-mono)', () => {
    const { container } = render(<CopyableText value="test" mono={false} />)
    expect(container.firstChild).toMatchSnapshot()
  })
})

describe('LanguageSwitcher snapshots', () => {
  it('LanguageSwitcher renders correctly', () => {
    const { container } = render(<LanguageSwitcher current="en" />)
    expect(container.firstChild).toMatchSnapshot()
  })
})

describe('Toast components snapshots', () => {
  it('Empty ToastContainer renders nothing', () => {
    const { container } = render(
      <ToastProvider>
        <ToastContainer />
      </ToastProvider>
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('Navbar snapshots', () => {
  it('Navbar renders correctly', () => {
    const { container } = render(<Navbar locale="en" />)
    expect(container.firstChild).toMatchSnapshot()
  })
})

describe('Empty state snapshots', () => {
  it('DashboardEmptyState renders correctly', () => {
    const { container } = render(<DashboardEmptyState />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('CertificatesEmptyState renders correctly', () => {
    const { container } = render(<CertificatesEmptyState />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('MetersEmptyState renders correctly', () => {
    const { container } = render(<MetersEmptyState />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('GovernanceEmptyState renders correctly', () => {
    const { container } = render(<GovernanceEmptyState />)
    expect(container.firstChild).toMatchSnapshot()
  })
})
