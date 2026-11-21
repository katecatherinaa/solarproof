'use client'

import { useRef, useState } from 'react'
import { X, ArrowRightLeft } from 'lucide-react'
import { CopyableText } from './copy-button'
import { useFocusTrap } from '../hooks/use-focus-trap'

interface Props {
  certificateId: string
  kwh: number
  onConfirm: (toAddress: string) => Promise<void>
  onClose: () => void
}

/** Basic Stellar address validation: starts with G and is 56 chars. */
function validateAddress(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Recipient address is required.'
  if (!trimmed.startsWith('G') || trimmed.length !== 56) {
    return 'Enter a valid Stellar account address (starts with G, 56 characters).'
  }
  return null
}

export function TransferModal({ certificateId, kwh, onConfirm, onClose }: Props) {
  const [toAddress, setToAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Trap focus inside the dialog, move initial focus to the heading, close on
  // Escape (unless submitting), and restore focus to the trigger on unmount.
  useFocusTrap(dialogRef, {
    onEscape: onClose,
    escapeEnabled: !submitting,
    initialFocus: 'heading',
  })

  function handleAddressChange(value: string) {
    setToAddress(value)
    if (touched) {
      setFieldError(validateAddress(value))
    }
  }

  function handleBlur() {
    setTouched(true)
    setFieldError(validateAddress(toAddress))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setTouched(true)
    const error = validateAddress(toAddress)
    setFieldError(error)
    if (error) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onConfirm(toAddress.trim())
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Transfer failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const hasFieldError = touched && !!fieldError

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && !submitting && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl outline-none dark:bg-gray-900"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-blue-500" aria-hidden="true" />
            <h2
              id="transfer-title"
              tabIndex={-1}
              className="text-base font-semibold text-gray-900 outline-none dark:text-gray-100"
            >
              Transfer certificate
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            aria-label="Close transfer certificate dialog"
            className="rounded p-1 text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Transfer certificate{' '}
          <CopyableText value={certificateId} displayValue={`${certificateId.slice(0, 8)}…`} />
          {' '}({kwh} kWh) to another Stellar account.
        </p>

        {submitError && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            {submitError}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label
              htmlFor="transfer-to"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Recipient Stellar address
              <span className="ms-1 text-red-500" aria-hidden="true">*</span>
            </label>
            <input
              id="transfer-to"
              type="text"
              value={toAddress}
              onChange={(e) => handleAddressChange(e.target.value)}
              onBlur={handleBlur}
              disabled={submitting}
              aria-required="true"
              aria-invalid={hasFieldError || undefined}
              aria-describedby={hasFieldError ? 'transfer-to-err' : 'transfer-to-hint'}
              placeholder="G…"
              autoComplete="off"
              className={`w-full rounded-lg border bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus-visible:ring-1 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500 ${
                hasFieldError
                  ? 'border-red-400 focus-visible:border-red-400 focus-visible:ring-red-400 dark:border-red-500'
                  : 'border-gray-300 focus-visible:border-blue-400 focus-visible:ring-blue-400 dark:border-gray-700'
              }`}
            />
            <p id="transfer-to-hint" className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Stellar account address — starts with G, 56 characters
            </p>
            {hasFieldError && (
              <p
                id="transfer-to-err"
                role="alert"
                aria-live="polite"
                className="mt-1 flex items-center gap-1 text-xs text-red-600 dark:text-red-400"
              >
                <svg className="h-3 w-3 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                {fieldError}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || (touched && !!fieldError)}
              aria-busy={submitting}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && (
                <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {submitting ? 'Transferring…' : 'Confirm transfer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
