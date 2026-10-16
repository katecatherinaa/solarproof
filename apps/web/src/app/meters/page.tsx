'use client'

import React, { useState } from 'react'
import { WalletGate } from '@/components/wallet-gate'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusCircle, ShieldOff } from 'lucide-react'
import { TableRowSkeleton } from '@/components/skeleton'

interface Meter {
  id: string
  name: string
  serial_number: string
  pubkey_hex: string
  active: boolean
  created_at: string
  cooperative_id: string
  meter_group: string | null
  tags: string[]
}

async function fetchMeters(): Promise<Meter[]> {
  const res = await fetch('/api/meters')
  if (!res.ok) throw new Error('Failed to load meters')
  return res.json()
}

async function registerMeter(body: {
  name: string
  serial_number: string
  pubkey_hex: string
  meter_group?: string
  tags?: string[]
}): Promise<Meter> {
  const res = await fetch('/api/meters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error ?? 'Registration failed')
  }
  return res.json()
}

async function revokeMeter(id: string): Promise<void> {
  const res = await fetch(`/api/meters/${id}/revoke`, { method: 'PATCH' })
  if (!res.ok) throw new Error('Revoke failed')
}

// ---------------------------------------------------------------------------
// Accessible field wrapper
// ---------------------------------------------------------------------------

interface FieldProps {
  id: string
  label: string
  error?: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}

function Field({ id, label, error, hint, required, children }: FieldProps) {
  const errorId = `${id}-err`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(' ') || undefined

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
      >
        {label}
        {required && (
          <span className="ms-1 text-red-500" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {hint && (
        <p id={hintId} className="mb-1 text-xs text-gray-400 dark:text-gray-500">
          {hint}
        </p>
      )}
      {/* Clone child and inject aria props */}
      {cloneWithA11y(children, { id, errorId: error ? errorId : undefined, describedBy, hasError: !!error })}
      {error && (
        <p
          id={errorId}
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
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Inject aria-invalid, aria-describedby and error-state border class into the
 * immediate child element (an <input> or <textarea>).
 */
function cloneWithA11y(
  children: React.ReactNode,
  opts: { id: string; errorId?: string; describedBy?: string; hasError: boolean }
): React.ReactNode {
  const child = React.Children.only(children) as React.ReactElement<React.HTMLAttributes<HTMLElement> & { 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' }>
  const baseClass: string = child.props.className ?? ''
  const errorClass = opts.hasError
    ? baseClass
        .replace('border-gray-300', 'border-red-400')
        .replace('dark:border-gray-700', 'dark:border-red-500')
    : baseClass
  return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
    'aria-invalid': opts.hasError ? ('true' as const) : undefined,
    'aria-describedby': opts.describedBy,
    className: errorClass,
  })
}

const INPUT_BASE =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yellow-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500'

// ---------------------------------------------------------------------------
// Register form
// ---------------------------------------------------------------------------

interface RegisterFormState {
  name: string
  serial_number: string
  pubkey_hex: string
  meter_group: string
  tags: string
}

interface RegisterFormErrors {
  name?: string
  serial_number?: string
  pubkey_hex?: string
}

function validateRegisterForm(form: RegisterFormState): RegisterFormErrors {
  const errors: RegisterFormErrors = {}
  if (!form.name.trim()) {
    errors.name = 'Meter name is required.'
  } else if (form.name.trim().length < 2) {
    errors.name = 'Meter name must be at least 2 characters.'
  }
  if (!form.serial_number.trim()) {
    errors.serial_number = 'Serial number is required.'
  }
  if (!form.pubkey_hex.trim()) {
    errors.pubkey_hex = 'Ed25519 public key is required.'
  } else if (!/^[0-9a-fA-F]{64}$/.test(form.pubkey_hex.trim())) {
    errors.pubkey_hex = 'Must be exactly 64 hexadecimal characters.'
  }
  return errors
}

function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const [form, setForm] = useState<RegisterFormState>({
    name: '',
    serial_number: '',
    pubkey_hex: '',
    meter_group: '',
    tags: '',
  })
  const [fieldErrors, setFieldErrors] = useState<RegisterFormErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Track which fields have been touched to avoid showing errors before first submit
  const [touched, setTouched] = useState<Partial<Record<keyof RegisterFormErrors, boolean>>>({})

  const mutation = useMutation({
    mutationFn: (data: RegisterFormState) =>
      registerMeter({
        ...data,
        tags: data.tags
          ? data.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        meter_group: data.meter_group || undefined,
      }),
    onSuccess: () => {
      setForm({ name: '', serial_number: '', pubkey_hex: '', meter_group: '', tags: '' })
      setFieldErrors({})
      setSubmitError(null)
      setTouched({})
      onSuccess()
    },
    onError: (err: Error) => setSubmitError(err.message),
  })

  function handleBlur(field: keyof RegisterFormErrors) {
    setTouched((t) => ({ ...t, [field]: true }))
    const errors = validateRegisterForm(form)
    setFieldErrors((prev) => ({ ...prev, [field]: errors[field] }))
  }

  function handleChange<K extends keyof RegisterFormState>(field: K, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    // Clear error on change once field has been touched
    if (touched[field as keyof RegisterFormErrors]) {
      const updated = { ...form, [field]: value }
      const errors = validateRegisterForm(updated)
      setFieldErrors((prev) => ({ ...prev, [field]: errors[field as keyof RegisterFormErrors] }))
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    const errors = validateRegisterForm(form)
    setFieldErrors(errors)
    // Mark all required fields as touched so errors are visible
    setTouched({ name: true, serial_number: true, pubkey_hex: true })
    if (Object.keys(errors).length > 0) return
    mutation.mutate(form)
  }

  const hasFieldErrors = Object.values(fieldErrors).some(Boolean)

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900"
      aria-label="Register new meter"
    >
      <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-gray-100">
        Register new meter
      </h2>

      {submitError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400"
        >
          {submitError}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          id="meter-name"
          label="Meter name"
          required
          error={touched.name ? fieldErrors.name : undefined}
        >
          <input
            id="meter-name"
            type="text"
            value={form.name}
            onChange={(e) => handleChange('name', e.target.value)}
            onBlur={() => handleBlur('name')}
            placeholder="Solar Array A - Meter 1"
            autoComplete="off"
            className={INPUT_BASE}
          />
        </Field>

        <Field
          id="meter-serial"
          label="Serial number"
          required
          error={touched.serial_number ? fieldErrors.serial_number : undefined}
        >
          <input
            id="meter-serial"
            type="text"
            value={form.serial_number}
            onChange={(e) => handleChange('serial_number', e.target.value)}
            onBlur={() => handleBlur('serial_number')}
            placeholder="MTR-001"
            autoComplete="off"
            className={INPUT_BASE}
          />
        </Field>

        <Field
          id="meter-pubkey"
          label="Ed25519 public key"
          required
          hint="64 hexadecimal characters"
          error={touched.pubkey_hex ? fieldErrors.pubkey_hex : undefined}
        >
          <input
            id="meter-pubkey"
            type="text"
            value={form.pubkey_hex}
            onChange={(e) => handleChange('pubkey_hex', e.target.value)}
            onBlur={() => handleBlur('pubkey_hex')}
            placeholder="0a1b2c…"
            autoComplete="off"
            inputMode="text"
            className={`${INPUT_BASE} font-mono`}
          />
        </Field>

        <Field id="meter-group" label="Group (optional)">
          <input
            id="meter-group"
            type="text"
            value={form.meter_group}
            onChange={(e) => handleChange('meter_group', e.target.value)}
            placeholder="North Farm"
            className={INPUT_BASE}
          />
        </Field>

        <Field id="meter-tags" label="Labels (optional)" hint="Comma-separated values">
          <input
            id="meter-tags"
            type="text"
            value={form.tags}
            onChange={(e) => handleChange('tags', e.target.value)}
            placeholder="residential, phase-1"
            className={INPUT_BASE}
          />
        </Field>
      </div>

      <button
        type="submit"
        disabled={mutation.isPending || hasFieldErrors}
        aria-busy={mutation.isPending}
        aria-disabled={mutation.isPending || hasFieldErrors}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-yellow-400 px-4 py-2 text-sm font-medium text-gray-900 transition-colors hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {mutation.isPending ? (
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
        ) : (
          <PlusCircle className="h-4 w-4" aria-hidden="true" />
        )}
        {mutation.isPending ? 'Registering…' : 'Register meter'}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Revoke confirmation dialog
// ---------------------------------------------------------------------------
function RevokeDialog({
  meter,
  onConfirm,
  onCancel,
  pending,
}: {
  meter: Meter
  onConfirm: () => void
  onCancel: () => void
  pending: boolean
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900">
        <h3
          id="revoke-title"
          className="mb-2 text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          Revoke meter?
        </h3>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Meter <span className="font-mono font-medium">{meter.serial_number}</span> will be
          deactivated and can no longer submit readings.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={pending}
            className="rounded-md px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending && (
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
            {pending ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Meters page
// ---------------------------------------------------------------------------
export default function MetersPage() {
  const qc = useQueryClient()
  const [revokeTarget, setRevokeTarget] = useState<Meter | null>(null)

  const { data: meters, isLoading, error } = useQuery({
    queryKey: ['meters'],
    queryFn: fetchMeters,
  })

  const revokeMutation = useMutation({
    mutationFn: revokeMeter,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meters'] })
      setRevokeTarget(null)
    },
  })

  return (
    <WalletGate>
      <div className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">Meters</h1>

        <div className="mb-8">
          <RegisterForm onSuccess={() => qc.invalidateQueries({ queryKey: ['meters'] })} />
        </div>

        {error && (
          <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
            Failed to load meters.
          </p>
        )}

        <div
          className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800"
          aria-busy={isLoading}
        >
          <div className="overflow-x-auto">
            <table
              className="min-w-full divide-y divide-gray-200 bg-white text-sm dark:divide-gray-800 dark:bg-gray-900"
              aria-label="Registered meters"
              aria-busy={isLoading}
            >
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/50">
                  {['Name', 'Serial number', 'Group', 'Labels', 'Status', 'Actions'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody
                className="divide-y divide-gray-100 dark:divide-gray-800"
                aria-busy={isLoading}
                aria-live="polite"
              >
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRowSkeleton key={i} cols={6} />
                  ))
                ) : meters && meters.length > 0 ? (
                  meters.map((m) => (
                    <tr
                      key={m.id}
                      className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                        {m.name}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {m.serial_number}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {m.meter_group || <span className="italic text-gray-400">None</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {m.tags.length > 0 ? (
                            m.tags.map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                              >
                                {tag}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            m.active
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          }`}
                        >
                          {m.active ? 'Active' : 'Revoked'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {m.active && (
                          <button
                            onClick={() => setRevokeTarget(m)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                            aria-label={`Revoke meter ${m.serial_number}`}
                          >
                            <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400"
                    >
                      No meters registered yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {revokeTarget && (
          <RevokeDialog
            meter={revokeTarget}
            onConfirm={() => revokeMutation.mutate(revokeTarget.id)}
            onCancel={() => setRevokeTarget(null)}
            pending={revokeMutation.isPending}
          />
        )}
      </div>
    </WalletGate>
  )
}
