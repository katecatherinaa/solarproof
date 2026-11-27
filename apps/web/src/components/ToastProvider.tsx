'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { X, CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export type ToastVariant = 'success' | 'error' | 'warning' | 'info'

export interface ToastPayload {
  title: string
  description: string
  variant: ToastVariant
}

interface ToastMessage extends ToastPayload {
  id: string
}

interface ToastContextValue {
  pushToast: (toast: ToastPayload) => void
}

interface NotificationRow {
  id: string
  cooperative_id: string
  title: string
  body: string | null
  variant: ToastVariant | null
}

interface ToastProviderProps {
  children: React.ReactNode
  cooperativeId?: string
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children, cooperativeId }: ToastProviderProps) {
  const t = useTranslations('toast')
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const pushToast = useCallback((toast: ToastPayload) => {
    setToasts((current) => [...current, { ...toast, id: crypto.randomUUID() }])
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  useEffect(() => {
    if (!cooperativeId) return

    const supabase = createClient()
    const channel = supabase
      .channel(`notifications:${cooperativeId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `cooperative_id=eq.${cooperativeId}`,
        },
        (payload) => {
          const row = payload.new as NotificationRow
          pushToast({
            title: row.title,
            description: row.body ?? '',
            variant: row.variant ?? 'info',
          })
        }
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [cooperativeId, pushToast])

  useEffect(() => {
    if (toasts.length === 0) return

    const timers = toasts.map((toast) =>
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== toast.id))
      }, 6000)
    )

    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [toasts])

  const iconMap = {
    success: CheckCircle2,
    error: X,
    warning: AlertTriangle,
    info: Info,
  } as const

  const toneMap: Record<ToastVariant, string> = {
    success: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    error: 'text-red-700 bg-red-50 border-red-200',
    warning: 'text-amber-700 bg-amber-50 border-amber-200',
    info: 'text-sky-700 bg-sky-50 border-sky-200',
  }

  const contextValue = useMemo(() => ({ pushToast }), [pushToast])

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div aria-live="polite" aria-atomic="true" role="status" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4 sm:bottom-4 sm:px-6">
        <div className="flex w-full max-w-md flex-col gap-3">
          {toasts.map((toast) => {
            const Icon = iconMap[toast.variant]
            return (
              <div
                key={toast.id}
                className={`pointer-events-auto rounded-3xl border p-4 shadow-xl ring-1 ring-black/5 ${toneMap[toast.variant]}`}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{toast.title}</p>
                    <p className="mt-1 text-sm text-current/80">{toast.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissToast(toast.id)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full text-current/70 transition hover:text-current"
                    aria-label={t('dismiss', { title: toast.title })}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider.')
  }
  return context
}
