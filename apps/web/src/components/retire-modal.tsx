'use client' // .

import { useRef, useState } from 'react'
import { X, Leaf, CheckCircle } from 'lucide-react'
import { CopyableText } from './copy-button'
import { useFocusTrap } from '../hooks/use-focus-trap'

interface Props {
  certificateId: string
  kwh: number
  onConfirm: (reason: string) => Promise<void>
  onClose: () => void
  /**
   * Called synchronously when the user submits, before the transaction
   * round-trip begins. The parent should mark the certificate as
   * "Retiring…" optimistically so the list reflects the pending state
   * immediately. This is purely client-side; nothing is persisted to the
   * server until the transaction confirms.
   */
  onOptimisticStart?: () => void
  /**
   * Called when the transaction fails so the parent can revert the
   * optimistic "Retiring…" state. Receives the error that will also be
   * surfaced in the modal.
   */
  onOptimisticRevert?: (error: Error) => void
}

export function RetireModal({
  certificateId,
  kwh,
  onConfirm,
  onClose,
  onOptimisticStart,
  onOptimisticRevert,
}: Props) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [succeeded, setSucceeded] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const triggerRef = useRef<Element | null>(null)
  // Guard against double-submits (e.g. rapid Enter presses) so we never
  // start two concurrent retire transactions from the same modal.
  const inFlightRef = useRef(false)

  // Trap focus inside the dialog, close on Escape (unless submitting), and
  // restore focus to the trigger element on unmount.
  const dialogRef = useFocusTrap<HTMLDivElement>({
    onEscape: () => {
      if (!submitting) onClose()
    },
    initialFocusRef: inputRef,
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (inFlightRef.current) return
    inFlightRef.current = true

    setSubmitting(true)
    setError(null)

    // Optimistically reflect the pending state in the parent list right away.
    // This is client-only; the retire request body is unchanged and nothing
    // is persisted until the transaction confirms.
    onOptimisticStart?.()

    try {
      await onConfirm(reason)
      setSucceeded(true)
    } catch (err) {
      const normalized =
        err instanceof Error ? err : new Error('Retirement failed. Please try again.')
      // Revert the optimistic state in the parent before surfacing the error.
      onOptimisticRevert?.(normalized)
      setError(normalized.message)
    } finally {
      inFlightRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && !submitting && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="retire-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl outline-none dark:bg-gray-900"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Leaf className="h-5 w-5 text-green-500" aria-hidden="true" />
            <h2 id="retire-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Retire certificate
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close retire modal"
            className="rounded p-1 text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {succeeded ? (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center gap-3 py-4 text-center"
          >
            <CheckCircle className="h-10 w-10 text-green-500" aria-hidden="true" />
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Certificate retired successfully.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
              You are about to permanently retire certificate{' '}
              <CopyableText value={certificateId} displayValue={`${certificateId.slice(0, 8)}…`} />
              {' '}({kwh.toFixed(3)} kWh). This action cannot be undone.
            </p>

            {error && (
              <div
                id="retire-error"
                role="alert"
                aria-live="assertive"
                className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <label
                  htmlFor="retire-reason"
                  className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Retirement reason{' '}
                  <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <textarea
                  id="retire-reason"
                  ref={inputRef}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  disabled={submitting}
                  placeholder="e.g. Offset Q1 2026 carbon footprint"
                  aria-describedby={error ? 'retire-error' : undefined}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-yellow-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-yellow-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
                />
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
                  disabled={submitting}
                  aria-busy={submitting}
                  aria-describedby={error ? 'retire-error' : undefined}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting && (
                    <svg
                      className="h-4 w-4 animate-spin"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  )}
                  {submitting ? 'Retiring…' : 'Confirm retirement'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}