'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Sun, Moon, Menu, X, Wallet, LogOut, Building2, ChevronDown, Check } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from '@/hooks/useWallet'
import { env } from '@/env'
import { CopyButton } from '@/components/copy-button'
import { LanguageSwitcher } from '@/components/language-switcher'

import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/locales'

interface NavbarProps {
  locale: Locale
}

const links = [
  { href: '/', labelKey: 'dashboard' },
  { href: '/meters', labelKey: 'meters' },
  { href: '/certificates', labelKey: 'certificates' },
  { href: '/explore', labelKey: 'explore' },
  { href: '/marketplace', labelKey: 'marketplace' },
  { href: '/governance', labelKey: 'governance' },
  { href: '/verify', labelKey: 'verify' },
  { href: '/admin', labelKey: 'admin' },
]

interface Cooperative {
  id: string
  name: string
}

interface CooperativeMeResponse {
  cooperative?: Cooperative | null
  cooperatives?: Cooperative[]
}

const network = env.NEXT_PUBLIC_STELLAR_NETWORK

function NetworkBadge() {
  const isMainnet = network === 'mainnet'
  return (
    <a
      href={
        isMainnet
          ? 'https://stellar.expert/explorer/public'
          : 'https://stellar.expert/explorer/testnet'
      }
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Stellar ${isMainnet ? 'Mainnet' : 'Testnet'} — view network info`}
      title={isMainnet ? 'Connected to Stellar Mainnet' : 'Connected to Stellar Testnet — not a production environment'}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
        isMainnet
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          isMainnet ? 'bg-green-500' : 'animate-pulse bg-yellow-500'
        }`}
      />
      {isMainnet ? 'Mainnet' : 'Testnet'}
    </a>
  )
}

export function Navbar({ locale }: NavbarProps) {
  const t = useTranslations('nav')
  const pathname = usePathname()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const { address, connected, loading: walletLoading, connect, disconnect } = useWallet()

  // Cooperative switcher state
  const [cooperatives, setCooperatives] = useState<Cooperative[]>([])
  const [currentCooperative, setCurrentCooperative] = useState<Cooperative | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const switcherRef = useRef<HTMLDivElement>(null)

  // Prevent hydration mismatch: only render theme/wallet UI after mount
  useEffect(() => {
    setMounted(true)
  }, [])

  // Fetch the current cooperative and the list of available cooperatives
  useEffect(() => {
    if (!mounted || !connected) {
      setCooperatives([])
      setCurrentCooperative(null)
      return
    }
    let cancelled = false
    fetch('/api/cooperative/me', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<CooperativeMeResponse>) : null))
      .then((data) => {
        if (cancelled || !data) return
        const list = data.cooperatives ?? (data.cooperative ? [data.cooperative] : [])
        setCooperatives(list)
        setCurrentCooperative(data.cooperative ?? list[0] ?? null)
      })
      .catch(() => {
        if (!cancelled) {
          setCooperatives([])
          setCurrentCooperative(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [mounted, connected])

  // Close switcher on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false)
      }
    }
    if (switcherOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [switcherOpen])

  async function switchCooperative(id: string) {
    if (id === currentCooperative?.id || switching) {
      setSwitcherOpen(false)
      return
    }
    setSwitching(true)
    try {
      const res = await fetch('/api/auth/switch-cooperative', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cooperativeId: id }),
      })
      if (!res.ok) throw new Error('Failed to switch cooperative')
      const next = cooperatives.find((c) => c.id === id) ?? null
      setCurrentCooperative(next)
      setSwitcherOpen(false)
      // Invalidate all cached data so views reload for the new cooperative
      await queryClient.invalidateQueries()
      router.refresh()
    } catch {
      // Keep the previous cooperative on failure
    } finally {
      setSwitching(false)
    }
  }

  function toggleTheme() {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  // Close menu on route change
  useEffect(() => { setMenuOpen(false) }, [pathname])

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !menuButtonRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  // Trap focus inside mobile menu when open
  useEffect(() => {
    if (!menuOpen) return
    const focusable = menuRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
    focusable?.[0]?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        menuButtonRef.current?.focus()
      }
      if (e.key === 'Tab' && focusable && focusable.length > 0) {
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [menuOpen])

  return (
    <nav
      className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
      aria-label="Main navigation"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100"
          aria-label="SolarProof home"
        >
          <Sun className="h-5 w-5 text-yellow-500" aria-hidden="true" />
          SolarProof
        </Link>

        {/* Desktop nav links */}
        <div className="hidden items-center gap-6 md:flex" role="list">
          {links.map((l) => {
            const active = pathname === l.href
            return (
              <Link
                key={l.href}
                href={l.href}
                role="listitem"
                aria-current={active ? 'page' : undefined}
                className={`text-sm transition-colors ${
                  active
                    ? 'font-medium text-gray-900 dark:text-gray-100'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                }`}
              >
                {t(l.labelKey as Parameters<typeof t>[0])}
              </Link>
            )
          })}
        </div>

        {/* Right side: network badge + cooperative switcher + theme toggle + wallet + hamburger */}
        <div className="flex items-center gap-2">
          {/* Stellar network indicator — always visible, no browser API needed */}
          <NetworkBadge />

          {/* Cooperative switcher — only when the account has cooperatives */}
          {mounted && connected && currentCooperative && (
            <div ref={switcherRef} className="relative hidden md:block">
              <button
                onClick={() => setSwitcherOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={switcherOpen}
                aria-label={`Current cooperative: ${currentCooperative.name}. Switch cooperative`}
                disabled={switching}
                className="inline-flex max-w-[12rem] items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <Building2 className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
                <span className="truncate">{currentCooperative.name}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" aria-hidden="true" />
              </button>
              {switcherOpen && (
                <ul
                  role="listbox"
                  aria-label="Select cooperative"
                  className="absolute end-0 z-50 mt-1 w-56 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
                >
                  {cooperatives.map((c) => {
                    const active = c.id === currentCooperative.id
                    return (
                      <li key={c.id} role="option" aria-selected={active}>
                        <button
                          onClick={() => switchCooperative(c.id)}
                          disabled={switching}
                          className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm transition-colors disabled:opacity-60 ${
                            active
                              ? 'bg-yellow-50 font-medium text-gray-900 dark:bg-yellow-900/20 dark:text-yellow-300'
                              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                          }`}
                        >
                          <span className="truncate">{c.name}</span>
                          {active && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Wallet connect — only rendered client-side to avoid hydration mismatch */}
          {mounted && !walletLoading && (
            connected && address ? (
              <div className="hidden items-center gap-1 rounded-md border border-gray-200 px-3 py-1.5 dark:border-gray-700 md:flex">
                <Wallet className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" aria-hidden="true" />
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {address.slice(0, 4)}…{address.slice(-4)}
                </span>
                <CopyButton value={address} label={`Copy wallet address ${address}`} iconSize={12} />
                <button
                  onClick={disconnect}
                  aria-label={t('disconnectWallet')}
                  title="Disconnect"
                  className="ms-0.5 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200"
                >
                  <LogOut className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => connect().catch(() => {})}
                aria-label={t('connectWallet')}
                className="hidden items-center gap-1.5 rounded-md bg-yellow-400 px-3 py-1.5 text-xs font-medium text-gray-900 transition-colors hover:bg-yellow-500 md:flex"
              >
                <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                {t('connectWallet')}
              </button>
            )
          )}

          {/* Dark mode toggle — suppress until mounted to avoid hydration mismatch */}
          <button
            onClick={toggleTheme}
            aria-label={
              mounted
                ? resolvedTheme === 'dark'
                  ? t('switchLight')
                  : t('switchDark')
                : 'Toggle theme'
            }
            className="rounded-md p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            {mounted && resolvedTheme === 'dark' ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>

          {/* Hamburger — mobile only */}
          <button
            ref={menuButtonRef}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={menuOpen ? t('closeMenu') : t('openMenu')}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            className="rounded-md p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 md:hidden"
          >
            {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div
          id="mobile-menu"
          ref={menuRef}
          role="dialog"
          aria-label="Navigation menu"
          aria-modal="true"
          className="border-t border-gray-200 bg-white px-4 pb-4 pt-2 dark:border-gray-800 dark:bg-gray-900 md:hidden"
        >
          <nav aria-label="Mobile navigation">
            <ul className="space-y-1">
              {links.map((l) => {
                const active = pathname === l.href
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      aria-current={active ? 'page' : undefined}
                      className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-yellow-50 font-medium text-gray-900 dark:bg-yellow-900/20 dark:text-yellow-300'
                          : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100'
                      }`}
                    >
                      {t(l.labelKey as Parameters<typeof t>[0])}
                    </Link>
                  </li>
                )
              })}
            </ul>

            <div className="mt-4 rounded-2xl bg-gray-50 p-3 dark:bg-gray-950/80">
              <div className="flex flex-wrap items-center gap-2">
                <NetworkBadge />
                <button
                  onClick={toggleTheme}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  {mounted && resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
                </button>
              </div>

              {mounted && connected && currentCooperative && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Cooperative</p>
                  <ul role="listbox" aria-label="Select cooperative" className="mt-1 space-y-1">
                    {cooperatives.map((c) => {
                      const active = c.id === currentCooperative.id
                      return (
                        <li key={c.id} role="option" aria-selected={active}>
                          <button
                            onClick={() => switchCooperative(c.id)}
                            disabled={switching}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:opacity-60 ${
                              active
                                ? 'bg-yellow-50 font-medium text-gray-900 dark:bg-yellow-900/20 dark:text-yellow-300'
                                : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                            }`}
                          >
                            <span className="truncate">{c.name}</span>
                            {active && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {mounted && !walletLoading && (
                <div className="mt-3 space-y-2">
                  {connected && address ? (
                    <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
                      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Wallet connected</p>
                      <p className="mt-1 font-mono text-sm text-gray-900 dark:text-gray-100">{address.slice(0, 4)}…{address.slice(-4)}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <CopyButton value={address} label={`Copy wallet address ${address}`} iconSize={12} />
                        <button
                          onClick={disconnect}
                          className="rounded-md bg-red-100 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-800"
                        >
                          Disconnect
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => connect().catch(() => {})}
                      className="w-full rounded-lg bg-yellow-400 px-3 py-2 text-sm font-semibold text-gray-900 hover:bg-yellow-500"
                    >
                      {t('connectWallet')}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Language switcher in mobile menu */}
            <div className="mt-3 px-3">
              <LanguageSwitcher current={locale} />
            </div>
          </nav>
        </div>
      )}
    </nav>
  )
}
