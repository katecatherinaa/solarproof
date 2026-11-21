'use client'

import { useEffect, useState } from 'react'
import { Wallet, WifiOff, RefreshCw } from 'lucide-react'
import { useWallet } from '@/hooks/useWallet'
import { useTranslations } from 'next-intl'

/**
 * Wraps protected pages. Handles three wallet states:
 *
 * 1. Not connected — shows a connect-wallet prompt.
 * 2. Was connected but became disconnected mid-session (e.g. extension
 *    locked or account changed) — shows a reconnect prompt with a warning
 *    banner instead of silently breaking actions.
 * 3. Connected — renders children normally.
 *
 * All wallet-gated action buttons are disabled while the wallet is unavailable
 * so users never hit a broken state.
 *
 * Usage:
 *   export default function DashboardPage() {
 *     return <WalletGate>{/* page content *\/}</WalletGate>
 *   }
 *
 * Optional `variant` prop:
 *   "page"   — full-page centred prompt (default, used for protected routes)
 *   "inline" — compact banner suitable for embedding inside a section
 */
export type WalletGateVariant = 'page' | 'inline'

interface WalletGateProps {
  children: React.ReactNode
  variant?: WalletGateVariant
}

export function WalletGate({ children, variant = 'page' }: WalletGateProps) {
  const t = useTranslations('walletGate')
  const { connected, loading, connect } = useWallet()
  const [mounted, setMounted] = useState(false)
  const [wasConnected, setWasConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Track whether wallet was previously connected so we can distinguish
  // "never connected" from "disconnected mid-session".
  useEffect(() => {
    if (connected) {
      setWasConnected(true)
      setConnectError(null)
    }
  }, [connected])

  async function handleConnect() {
    setReconnecting(true)
    setConnectError(null)
    try {
      await connect()
    } catch (err) {
      // Prefer a translated message; fall back to the raw error text only
      // when it is not a generic/empty message.
      const message =
        err instanceof Error && err.message ? err.message : null
      setConnectError(message ?? t('connectError'))
    } finally {
      setReconnecting(false)
    }
  }

  // During SSR or before wallet state is resolved, render nothing to avoid
  // flashing the gate on pages where the wallet is already connected.
  if (!mounted || loading) return null

  if (!connected) {
    const isReconnect = wasConnected

    if (variant === 'inline') {
      return (
        <InlinePrompt
          isReconnect={isReconnect}
          reconnecting={reconnecting}
          connectError={connectError}
          onConnect={handleConnect}
          t={t}
        />
      )
    }

    return (
      <PagePrompt
        isReconnect={isReconnect}
        reconnecting={reconnecting}
        connectError={connectError}
        onConnect={handleConnect}
        t={t}
      />
    )
  }

  return <>{children}</>
}

// ── Full-page prompt ──────────────────────────────────────────────────────────

function PagePrompt({
  isReconnect,
  reconnecting,
  connectError,
  onConnect,
  t,
}: PromptProps) {
  return (
    <div
      className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center"
      role="status"
      aria-live="polite"
    >
      <div
        className={`flex h-16 w-16 items-center justify-center rounded-full ${
          isReconnect
            ? 'bg-red-100 dark:bg-red-900/30'
            : 'bg-yellow-100 dark:bg-yellow-900/30'
        }`}
      >
        {isReconnect ? (
          <WifiOff
            className="h-8 w-8 text-red-600 dark:text-red-400"
            aria-hidden="true"
          />
        ) : (
          <Wallet
            className="h-8 w-8 text-yellow-600 dark:text-yellow-400"
            aria-hidden="true"
          />
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {isReconnect ? t('disconnectedTitle') : t('title')}
        </h2>
        <p className="max-w-sm text-sm text-gray-600 dark:text-gray-400">
          {isReconnect ? t('disconnectedDescription') : t('description')}
        </p>
      </div>

      {connectError && (
        <p
          role="alert"
          className="max-w-sm rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400"
        >
          {connectError}
        </p>
      )}

      <button
        onClick={onConnect}
        disabled={reconnecting}
        aria-busy={reconnecting}
        aria-label={
          reconnecting
            ? t('connecting')
            : isReconnect
            ? t('reconnect')
            : t('connect')
        }
        className={`inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-medium text-gray-900 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
          isReconnect
            ? 'bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-500'
            : 'bg-yellow-400 hover:bg-yellow-500 focus-visible:ring-yellow-400'
        }`}
      >
        {reconnecting ? (
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : isReconnect ? (
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Wallet className="h-4 w-4" aria-hidden="true" />
        )}
        {reconnecting
          ? t('connecting')
          : isReconnect
          ? t('reconnect')
          : t('connect')}
      </button>

      {isReconnect && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {t('disconnectedHint')}
        </p>
      )}
    </div>
  )
}

// ── Inline prompt (compact banner) ───────────────────────────────────────────

function InlinePrompt({
  isReconnect,
  reconnecting,
  connectError,
  onConnect,
  t,
}: PromptProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ${
        isReconnect
          ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30'
          : 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/30'
      }`}
    >
      <div className="flex items-center gap-3">
        {isReconnect ? (
          <WifiOff
            className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400"
            aria-hidden="true"
          />
        ) : (
          <Wallet
            className="h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-400"
            aria-hidden="true"
          />
        )}
        <div>
          <p
            className={`text-sm font-medium ${
              isReconnect
                ? 'text-red-800 dark:text-red-300'
                : 'text-yellow-800 dark:text-yellow-300'
            }`}
          >
            {isReconnect ? t('disconnectedTitle') : t('title')}
          </p>
          {connectError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {connectError}
            </p>
          )}
        </div>
      </div>

      <button
        onClick={onConnect}
        disabled={reconnecting}
        aria-busy={reconnecting}
        aria-label={
          reconnecting
            ? t('connecting')
            : isReconnect
            ? t('reconnect')
            : t('connect')
        }
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 ${
          isReconnect
            ? 'bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-500'
            : 'bg-yellow-400 text-gray-900 hover:bg-yellow-500 focus-visible:ring-yellow-400'
        }`}
      >
        {reconnecting ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : isReconnect ? (
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {reconnecting
          ? t('connecting')
          : isReconnect
          ? t('reconnect')
          : t('connect')}
      </button>
    </div>
  )
}

// ── Shared prop types ─────────────────────────────────────────────────────────

interface PromptProps {
  isReconnect: boolean
  reconnecting: boolean
  connectError: string | null
  onConnect: () => void
  t: ReturnType<typeof useTranslations<'walletGate'>>
}
