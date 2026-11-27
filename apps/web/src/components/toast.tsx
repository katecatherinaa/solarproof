'use client'

import { createContext, useCallback, useContext, useReducer, useRef } from 'react'

export type ToastVariant = 'success' | 'error' | 'pending'

export interface Toast {
  id: string
  variant: ToastVariant
  message: string
}

type Action =
  | { type: 'ADD'; toast: Toast }
  | { type: 'REMOVE'; id: string }

function reducer(state: Toast[], action: Action): Toast[] {
  switch (action.type) {
    case 'ADD':
      return [...state, action.toast]
    case 'REMOVE':
      return state.filter((t) => t.id !== action.id)
  }
}

interface ToastContextValue {
  toasts: Toast[]
  toast: (variant: ToastVariant, message: string) => string
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, dispatch] = useReducer(reducer, [])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    dispatch({ type: 'REMOVE', id })
  }, [])

  const toast = useCallback(
    (variant: ToastVariant, message: string) => {
      const id = crypto.randomUUID()
      dispatch({ type: 'ADD', toast: { id, variant, message } })
      if (variant !== 'pending') {
        timers.current.set(id, setTimeout(() => dismiss(id), 5000))
      }
      return id
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

// ---------------------------------------------------------------------------
// Toast UI
// ---------------------------------------------------------------------------
import { CheckCircle, XCircle, Loader2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

const icons: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle,
  error: XCircle,
  pending: Loader2,
}

const styles: Record<ToastVariant, string> = {
  success: 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  pending: 'border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200',
}

export function ToastContainer() {
  const { toasts, dismiss } = useToast()
  const t = useTranslations('toast')
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      aria-label={t('notifications')}
      className="fixed end-4 bottom-4 z-50 flex flex-col gap-2"
    >
      {toasts.map((toast) => {
        const Icon = icons[toast.variant]
        return (
          <div
            key={toast.id}
            className={`flex max-w-sm items-start gap-3 rounded-lg border px-4 py-3 shadow-md ${styles[toast.variant]}`}
          >
            <Icon
              className={`mt-0.5 h-4 w-4 shrink-0 ${toast.variant === 'pending' ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <p className="flex-1 text-sm">{toast.message}</p>
            <button
              onClick={() => dismiss(toast.id)}
              aria-label={t('dismiss')}
              className="ms-1 shrink-0 opacity-60 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
