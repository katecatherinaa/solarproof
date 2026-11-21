'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

export interface EmptyStateCta {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface EmptyStateProps {
  /** Illustration node. Decorative SVGs should be marked aria-hidden. */
  illustration: ReactNode;
  /** Short, human-readable title. */
  title: string;
  /** One-sentence explanation of why the view is empty. */
  description: string;
  /** Primary call-to-action. */
  cta: EmptyStateCta;
  /** Optional accessible label for the illustration container. */
  illustrationLabel?: string;
  /** Optional additional class names. */
  className?: string;
}

const baseButtonClasses =
  'inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2';

function CtaButton({ cta }: { cta: EmptyStateCta }) {
  if (cta.href) {
    return (
      <Link href={cta.href} className={baseButtonClasses}>
        {cta.label}
      </Link>
    );
  }

  return (
    <button type="button" onClick={cta.onClick} className={baseButtonClasses}>
      {cta.label}
    </button>
  );
}

export function EmptyState({
  illustration,
  title,
  description,
  cta,
  illustrationLabel,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={[
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="status"
      aria-live="polite"
    >
      <div
        className="mb-6 flex h-32 w-32 items-center justify-center"
        {...(illustrationLabel
          ? { role: 'img', 'aria-label': illustrationLabel }
          : { 'aria-hidden': true })}
      >
        {illustration}
      </div>
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-gray-600">{description}</p>
      <div className="mt-6">
        <CtaButton cta={cta} />
      </div>
    </div>
  );
}

function DashboardIllustration() {
  return (
    <svg
      viewBox="0 0 128 128"
      className="h-full w-full text-emerald-500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="16" y="24" width="96" height="72" rx="8" stroke="currentColor" strokeWidth="3" />
      <path d="M16 44h96" stroke="currentColor" strokeWidth="3" />
      <circle cx="28" cy="34" r="3" fill="currentColor" />
      <circle cx="38" cy="34" r="3" fill="currentColor" />
      <circle cx="48" cy="34" r="3" fill="currentColor" />
      <path
        d="M32 84l16-16 12 12 20-24 16 16"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CertificatesIllustration() {
  return (
    <svg
      viewBox="0 0 128 128"
      className="h-full w-full text-emerald-500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="28" y="16" width="72" height="88" rx="6" stroke="currentColor" strokeWidth="3" />
      <path d="M44 40h40M44 56h40M44 72h24" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="88" cy="88" r="16" fill="white" stroke="currentColor" strokeWidth="3" />
      <path
        d="M82 88l4 4 8-8"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MetersIllustration() {
  return (
    <svg
      viewBox="0 0 128 128"
      className="h-full w-full text-emerald-500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="64" cy="64" r="40" stroke="currentColor" strokeWidth="3" />
      <path d="M64 64V36" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M64 64l20 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="64" cy="64" r="4" fill="currentColor" />
      <path d="M40 96l-8 12M88 96l8 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function GovernanceIllustration() {
  return (
    <svg
      viewBox="0 0 128 128"
      className="h-full w-full text-emerald-500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M64 16l40 20v20c0 24-16 44-40 56-24-12-40-32-40-56V36l40-20z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <path
        d="M48 64l12 12 24-24"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DashboardEmptyState(props?: Partial<Omit<EmptyStateProps, 'illustration'>>) {
  return (
    <EmptyState
      illustration={<DashboardIllustration />}
      title="No readings yet"
      description="Once your meters start reporting, your energy readings and trends will appear here."
      cta={{ label: 'Register your first meter', href: '/meters/register' }}
      {...props}
    />
  );
}

export function CertificatesEmptyState(props?: Partial<Omit<EmptyStateProps, 'illustration'>>) {
  return (
    <EmptyState
      illustration={<CertificatesIllustration />}
      title="No certificates yet"
      description="Energy certificates you issue or receive will be listed here once they are created."
      cta={{ label: 'Issue your first certificate', href: '/certificates/new' }}
      {...props}
    />
  );
}

export function MetersEmptyState(props?: Partial<Omit<EmptyStateProps, 'illustration'>>) {
  return (
    <EmptyState
      illustration={<MetersIllustration />}
      title="No meters registered"
      description="Register a meter to begin collecting readings and tracking your energy production."
      cta={{ label: 'Register your first meter', href: '/meters/register' }}
      {...props}
    />
  );
}

export function GovernanceEmptyState(props?: Partial<Omit<EmptyStateProps, 'illustration'>>) {
  return (
    <EmptyState
      illustration={<GovernanceIllustration />}
      title="No proposals yet"
      description="Governance proposals from your community will appear here once they are created."
      cta={{ label: 'Create your first proposal', href: '/governance/new' }}
      {...props}
    />
  );
}

export default EmptyState;