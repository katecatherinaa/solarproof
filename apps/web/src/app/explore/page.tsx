import type { Metadata } from 'next';
import { CertificateExplorer } from './certificate-explorer';

export const metadata: Metadata = {
  title: 'Certificate Explorer | Verified Certificates',
  description:
    'Explore all verified certificates from cooperatives. Filter by cooperative name, date range, and kWh range. Publicly accessible, no authentication required.',
  openGraph: {
    title: 'Certificate Explorer | Verified Certificates',
    description:
      'Explore all verified certificates from cooperatives. Filter by cooperative name, date range, and kWh range.',
    type: 'website',
    url: '/explore',
  },
};

export default function ExplorePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Certificate Explorer</h1>
        <p className="mt-2 text-muted-foreground">
          Browse all verified certificates from cooperatives. Filter by cooperative
          name, date range, and kWh range.
        </p>
      </header>
      <CertificateExplorer />
    </main>
  );
}