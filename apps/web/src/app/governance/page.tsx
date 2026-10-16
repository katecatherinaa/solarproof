'use client'
// .

import { useState } from 'react'
import { Vote, Plus, Clock, CheckCircle, XCircle, Minus, ChevronDown, ChevronUp } from 'lucide-react'
import { useWallet } from '@/hooks/useWallet'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ProposalListSkeleton } from '@/components/skeleton'

// ── Types ──────────────────────────────────────────────────────────────────────

type VoteChoice = 'for' | 'against' | 'abstain'
type ProposalStatus = 'active' | 'passed' | 'rejected' | 'pending' | 'expired'

interface Tally { for: number; against: number; abstain: number }

interface Proposal {
  id: string
  title: string
  description: string
  status: ProposalStatus
  tally: Tally
  ends_at: string
  userVote?: VoteChoice
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function fetchProposals(): Promise<Proposal[]> {
  const res = await fetch('/api/governance')
  if (!res.ok) throw new Error('Failed to load proposals')
  return res.json()
}

async function createProposal(body: {
  title: string
  description: string
  action: string
  days: number
}): Promise<Proposal> {
  const res = await fetch('/api/governance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error ?? 'Failed to create proposal')
  }
  return res.json()
}

async function castVote(proposalId: string, choice: VoteChoice): Promise<void> {
  const res = await fetch(`/api/governance/${proposalId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error ?? 'Failed to cast vote')
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function totalVotes(t: Tally) { return t.for + t.against + t.abstain }
function pct(n: number, total: number) { return total === 0 ? 0 : Math.round((n / total) * 100) }

function countdown(endsAtStr: string): string {
  const endsAt = new Date(endsAtStr)
  const diff = endsAt.getTime() - Date.now()
  if (diff <= 0) return 'Ended'
  const d = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  return d > 0 ? `${d}d ${h}h remaining` : `${h}h remaining`
}

const STATUS_BADGE: Record<ProposalStatus, string> = {
  active: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  passed: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  expired: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function TallyBar({ tally }: { tally: Tally }) {
  const total = totalVotes(tally)
  const forPct = pct(tally.for, total)
  const againstPct = pct(tally.against, total)
  const abstainPct = pct(tally.abstain, total)
  return (
    <div className="space-y-1.5">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
        aria-label={`Tally: ${forPct}% for, ${againstPct}% against, ${abstainPct}% abstain`}
        role="img"
      >
        <div className="bg-green-500" style={{ width: `${forPct}%` }} aria-hidden="true" />
        <div className="bg-red-500" style={{ width: `${againstPct}%` }} aria-hidden="true" />
        <div className="bg-gray-400 dark:bg-gray-600" style={{ width: `${abstainPct}%` }} aria-hidden="true" />
      </div>
      <ul className="flex gap-4 text-xs text-gray-500 dark:text-gray-400" aria-label="Vote tally legend">
        <li>
          <span aria-label={`For votes: ${forPct} percent, ${tally.for} votes`}>
            <span className="font-medium text-green-600 dark:text-green-400">{forPct}%</span> For ({tally.for})
          </span>
        </li>
        <li>
          <span aria-label={`Against votes: ${againstPct} percent, ${tally.against} votes`}>
            <span className="font-medium text-red-600 dark:text-red-400">{againstPct}%</span> Against ({tally.against})
          </span>
        </li>
        <li>
          <span aria-label={`Abstain votes: ${abstainPct} percent, ${tally.abstain} votes`}>
            <span className="font-medium text-gray-500">{abstainPct}%</span> Abstain ({tally.abstain})
          </span>
        </li>
      </ul>
    </div>
  )
}

function VoteButtons({
  proposalId,
  userVote,
  disabled,
  onVote,
}: {
  proposalId: string
  userVote?: VoteChoice
  disabled: boolean
  onVote: (id: string, choice: VoteChoice) => void
}) {
  const btn = (choice: VoteChoice, label: string, Icon: React.ElementType, color: string) => {
    const active = userVote === choice
    return (
      <button
        key={choice}
        onClick={() => onVote(proposalId, choice)}
        disabled={disabled || !!userVote}
        aria-pressed={active}
        aria-label={`Vote ${label}`}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${
          active
            ? `${color} border-transparent`
            : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
        }`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
    )
  }
  return (
    <div className="flex flex-wrap gap-2">
      {btn('for', 'For', CheckCircle, 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300')}
      {btn('against', 'Against', XCircle, 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300')}
      {btn('abstain', 'Abstain', Minus, 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400')}
    </div>
  )
}

function ProposalCard({
  proposal,
  onVote,
  walletConnected,
  isVoting,
}: {
  proposal: Proposal
  onVote: (id: string, choice: VoteChoice) => void
  walletConnected: boolean
  isVoting: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const isActive = proposal.status === 'active' && new Date(proposal.ends_at) > new Date()

  return (
    <article
      aria-labelledby={`prop-title-${proposal.id}`}
      className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_BADGE[proposal.status]}`}>
              {proposal.status}
            </span>
            {isActive && (
              <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
                <Clock className="h-3 w-3" aria-hidden="true" />
                {countdown(proposal.ends_at)}
              </span>
            )}
          </div>
          <h2 id={`prop-title-${proposal.id}`} className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {proposal.title}
          </h2>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`prop-body-${proposal.id}`}
          aria-label={expanded ? 'Collapse proposal' : 'Expand proposal'}
          className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <div id={`prop-body-${proposal.id}`} className="mt-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">{proposal.description}</p>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <TallyBar tally={proposal.tally} />
        {isActive && (
          <div>
            {!walletConnected && (
              <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">Connect your wallet to vote.</p>
            )}
            <VoteButtons
              proposalId={proposal.id}
              userVote={proposal.userVote}
              disabled={!walletConnected || isVoting}
              onVote={onVote}
            />
            {isVoting && (
              <p role="status" aria-live="polite" className="mt-2 flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Submitting vote…
              </p>
            )}
            {!isVoting && proposal.userVote && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                You voted <span className="font-medium capitalize">{proposal.userVote}</span>.
              </p>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

// ── Create Proposal Form ───────────────────────────────────────────────────────

interface FormState { title: string; description: string; days: string; action: string }
const EMPTY: FormState = { title: '', description: '', days: '7', action: '' }

function CreateProposalForm({ onCreated }: { onCreated: () => void }) {
  const { connected, connect } = useWallet()
  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Partial<FormState>>({})
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (data: typeof form) => createProposal({
      title: data.title,
      description: data.description,
      action: data.action,
      days: Number(data.days),
    }),
    onSuccess: () => {
      onCreated()
      setForm(EMPTY)
      setErrors({})
      setSubmitError(null)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    },
    onError: (err: Error) => setSubmitError(err.message),
  })

  function validate(): boolean {
    const e: Partial<FormState> = {}
    if (!form.title.trim()) e.title = 'Title is required.'
    if (!form.description.trim()) e.description = 'Description is required.'
    const d = Number(form.days)
    if (!form.days || isNaN(d) || d < 1 || d > 30) e.days = 'Enter a number between 1 and 30.'
    if (!form.action.trim()) e.action = 'Proposed action is required.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    if (!validate()) return
    if (!connected) {
      try { await connect() } catch { return }
    }
    mutation.mutate(form)
  }

  return (
    <section aria-labelledby="create-proposal-heading" className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 id="create-proposal-heading" className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        New Proposal
      </h2>
      {success && (
        <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
          <CheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Proposal submitted successfully!
        </div>
      )}
      {submitError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400"
        >
          {submitError}
        </div>
      )}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field
          id="prop-title"
          label="Title"
          required
          error={errors.title}
        >
          <input
            id="prop-title"
            type="text"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            maxLength={120}
            aria-required="true"
            aria-describedby={errors.title ? 'prop-title-err' : undefined}
            aria-invalid={!!errors.title}
            placeholder="Short, descriptive title"
            className="input-base"
          />
        </Field>

        <Field id="prop-desc" label="Description" required error={errors.description}>
          <textarea
            id="prop-desc"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={3}
            maxLength={1000}
            aria-required="true"
            aria-describedby={errors.description ? 'prop-desc-err' : undefined}
            aria-invalid={!!errors.description}
            placeholder="Explain the motivation and expected impact…"
            className="input-base resize-none"
          />
        </Field>

        <Field id="prop-action" label="Proposed action" required error={errors.action}>
          <input
            id="prop-action"
            type="text"
            value={form.action}
            onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
            maxLength={200}
            aria-required="true"
            aria-describedby={errors.action ? 'prop-action-err' : undefined}
            aria-invalid={!!errors.action}
            placeholder="e.g. update_param, call_contract, transfer_funds"
            className="input-base"
          />
        </Field>

        <Field id="prop-days" label="Voting deadline (days)" required error={errors.days}>
          <input
            id="prop-days"
            type="number"
            min={1}
            max={30}
            value={form.days}
            onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
            aria-required="true"
            aria-describedby={errors.days ? 'prop-days-err' : undefined}
            aria-invalid={!!errors.days}
            className="input-base w-28"
          />
        </Field>

        <button
          type="submit"
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-yellow-400 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {mutation.isPending ? 'Submitting…' : connected ? 'Submit Proposal' : 'Connect Wallet & Submit'}
        </button>
      </form>
    </section>
  )
}

function Field({
  id,
  label,
  error,
  required,
  children,
}: {
  id: string
  label: string
  error?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {required && (
          <span className="ms-1 text-red-500" aria-hidden="true">*</span>
        )}
      </label>
      <div className={`w-full [&>input]:w-full [&>textarea]:w-full [&>input]:rounded-lg [&>textarea]:rounded-lg [&>input]:border [&>textarea]:border [&>input]:px-3 [&>textarea]:px-3 [&>input]:py-1.5 [&>textarea]:py-1.5 [&>input]:text-sm [&>textarea]:text-sm [&>input]:outline-none [&>textarea]:outline-none [&>input]:bg-white [&>textarea]:bg-white dark:[&>input]:bg-gray-800 dark:[&>textarea]:bg-gray-800 [&>input]:text-gray-900 [&>textarea]:text-gray-900 dark:[&>input]:text-gray-100 dark:[&>textarea]:text-gray-100 [&>input]:transition-colors [&>textarea]:transition-colors [&>input:focus]:ring-2 [&>textarea:focus]:ring-2 [&>input:focus]:ring-yellow-400 [&>textarea:focus]:ring-yellow-400 ${error ? '[&>input]:border-red-400 [&>textarea]:border-red-400 dark:[&>input]:border-red-500 dark:[&>textarea]:border-red-500' : '[&>input]:border-gray-300 [&>textarea]:border-gray-300 dark:[&>input]:border-gray-700 dark:[&>textarea]:border-gray-700'}`}>
        {children}
      </div>
      {error && (
        <p
          id={`${id}-err`}
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

// ── Page ───────────────────────────────────────────────────────────────────────

export default function GovernancePage() {
  const { connected } = useWallet()
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [voteError, setVoteError] = useState<string | null>(null)
  const [tallyRefetching, setTallyRefetching] = useState(false)

  const { data: proposals = [], isLoading, error } = useQuery({
    queryKey: ['proposals'],
    queryFn: fetchProposals,
  })

  const voteMutation = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: VoteChoice }) => castVote(id, choice),
    // Optimistic update: immediately reflect the user's vote and increment the tally
    onMutate: async ({ id, choice }) => {
      await qc.cancelQueries({ queryKey: ['proposals'] })
      const previous = qc.getQueryData<Proposal[]>(['proposals'])
      qc.setQueryData<Proposal[]>(['proposals'], (old = []) =>
        old.map((p) => {
          if (p.id !== id) return p
          const newTally = { ...p.tally, [choice]: p.tally[choice] + 1 }
          return { ...p, tally: newTally, userVote: choice }
        })
      )
      return { previous }
    },
    onError: (err: Error, _vars, context) => {
      // Roll back optimistic update on failure
      if (context?.previous) {
        qc.setQueryData(['proposals'], context.previous)
      }
      setVoteError(err.message)
    },
    onSettled: async () => {
      // Re-fetch to sync server-authoritative tally
      setTallyRefetching(true)
      await qc.invalidateQueries({ queryKey: ['proposals'] })
      setTallyRefetching(false)
      setVoteError(null)
    },
  })

  function handleVote(id: string, choice: VoteChoice) {
    voteMutation.mutate({ id, choice })
  }

  function handleCreated() {
    qc.invalidateQueries({ queryKey: ['proposals'] })
    setShowForm(false)
  }

  const active = proposals.filter((p) => p.status === 'active' && new Date(p.ends_at) > new Date())
  const closed = proposals.filter((p) => p.status !== 'active' || new Date(p.ends_at) <= new Date())
  // Id of the proposal currently being voted on (for per-card loading state)
  const votingProposalId = voteMutation.isPending ? voteMutation.variables?.id : undefined

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <header className="mb-8 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Vote className="h-7 w-7 shrink-0 text-yellow-500" aria-hidden="true" />
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">Governance</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Community proposals for your cooperative.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          aria-expanded={showForm}
          aria-controls="create-proposal-section"
          className="flex items-center gap-1.5 rounded-lg bg-yellow-400 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Proposal
        </button>
      </header>

      {showForm && (
        <div id="create-proposal-section" className="mb-8">
          <CreateProposalForm onCreated={handleCreated} />
        </div>
      )}

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
          Failed to load proposals.
        </p>
      )}

      {voteError && (
        <div
          role="alert"
          aria-live="polite"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400"
        >
          {voteError}
        </div>
      )}

      {tallyRefetching && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
        >
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Refreshing vote tallies…
        </div>
      )}

      {isLoading ? (
        <ProposalListSkeleton count={2} />
      ) : active.length > 0 ? (
        <section aria-labelledby="active-heading" className="mb-8">
          <h2 id="active-heading" className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Active ({active.length})
          </h2>
          <div className="space-y-4">
            {active.map((p) => (
              <ProposalCard key={p.id} proposal={p} onVote={handleVote} walletConnected={connected} isVoting={votingProposalId === p.id} />
            ))}
          </div>
        </section>
      ) : null}

      {!isLoading && closed.length > 0 && (
        <section aria-labelledby="closed-heading">
          <h2 id="closed-heading" className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Closed ({closed.length})
          </h2>
          <div className="space-y-4">
            {closed.map((p) => (
              <ProposalCard key={p.id} proposal={p} onVote={handleVote} walletConnected={connected} isVoting={false} />
            ))}
          </div>
        </section>
      )}

      {!isLoading && active.length === 0 && closed.length === 0 && (
        <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
          No proposals found for your cooperative.
        </p>
      )}
    </div>
  )
}
