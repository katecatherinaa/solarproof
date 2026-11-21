import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CertificateQRCode } from '@/components/CertificateQRCode';

export const dynamic = 'force-static';
export const revalidate = 3600;

interface CertificateData {
  id: string;
  kwh: number;
  issuedDate: string;
  cooperativeName: string;
  retired: boolean;
}

interface PageProps {
  params: { id: string };
}

async function getCertificate(id: string): Promise<CertificateData | null> {
  const apiBase =
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.API_URL ??
    'http://localhost:3001';

  try {
    const res = await fetch(
      `${apiBase}/api/certificates/${encodeURIComponent(id)}/public`,
      {
        next: { revalidate: 3600 },
        headers: { Accept: 'application/json' },
      },
    );

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as Partial<CertificateData>;

    if (
      typeof data.kwh !== 'number' ||
      typeof data.issuedDate !== 'string' ||
      typeof data.cooperativeName !== 'string'
    ) {
      return null;
    }

    return {
      id,
      kwh: data.kwh,
      issuedDate: data.issuedDate,
      cooperativeName: data.cooperativeName,
      retired: Boolean(data.retired),
    };
  } catch {
    return null;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatKwh(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value);
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const certificate = await getCertificate(params.id);

  const title = certificate
    ? `Verified Green Energy Certificate ${params.id}`
    : `Certificate ${params.id}`;

  return {
    title,
    description: certificate
      ? `${formatKwh(certificate.kwh)} kWh of verified green energy issued by ${certificate.cooperativeName}.`
      : 'Verified green energy certificate.',
    robots: { index: true, follow: true },
  };
}

export default async function EmbedCertificatePage({ params }: PageProps) {
  // Ensure cache-friendly response headers for the embeddable page.
  const headersList = headers();
  void headersList;

  const certificate = await getCertificate(params.id);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: 'transparent',
          color: '#0f172a',
        }}
      >
        <main
          style={{
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: 420,
            margin: '0 auto',
            padding: 16,
          }}
        >
          <div
            style={{
              border: '1px solid #d1fae5',
              borderRadius: 12,
              background: '#ffffff',
              boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
              padding: 16,
            }}
          >
            <header
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: '#047857',
                }}
              >
                Verified Green Energy
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  background: certificate?.retired ? '#e5e7eb' : '#d1fae5',
                  color: certificate?.retired ? '#374151' : '#047857',
                }}
              >
                {certificate?.retired ? 'Retired' : 'Active'}
              </span>
            </header>

            {certificate ? (
              <>
                <dl
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr',
                    rowGap: 8,
                    columnGap: 12,
                    margin: 0,
                    fontSize: 14,
                  }}
                >
                  <dt style={{ color: '#64748b' }}>Energy</dt>
                  <dd style={{ margin: 0, fontWeight: 600 }}>
                    {formatKwh(certificate.kwh)} kWh
                  </dd>

                  <dt style={{ color: '#64748b' }}>Issued</dt>
                  <dd style={{ margin: 0, fontWeight: 600 }}>
                    {formatDate(certificate.issuedDate)}
                  </dd>

                  <dt style={{ color: '#64748b' }}>Cooperative</dt>
                  <dd style={{ margin: 0, fontWeight: 600 }}>
                    {certificate.cooperativeName}
                  </dd>

                  <dt style={{ color: '#64748b' }}>Status</dt>
                  <dd style={{ margin: 0, fontWeight: 600 }}>
                    {certificate.retired ? 'Retired' : 'Active'}
                  </dd>
                </dl>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    marginTop: 16,
                  }}
                >
                  <CertificateQRCode
                    certificateId={certificate.id}
                    size={140}
                  />
                </div>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 14, color: '#64748b' }}>
                Certificate not found.
              </p>
            )}

            <footer
              style={{
                marginTop: 16,
                paddingTop: 12,
                borderTop: '1px solid #f1f5f9',
                textAlign: 'center',
                fontSize: 12,
              }}
            >
              <a
                href={`https://solarproof.io/verify/${encodeURIComponent(
                  params.id,
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#047857', fontWeight: 600 }}
              >
                Verify on SolarProof
              </a>
            </footer>
          </div>
        </main>
      </body>
    </html>
  );
}