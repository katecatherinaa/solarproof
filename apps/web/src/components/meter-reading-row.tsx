import { useTranslations } from 'next-intl'

interface MeterReadingRowProps {
  id: string
  meter_id: string
  kwh: number
  timestamp: string
  verified: boolean
}

export function MeterReadingRow({ id, meter_id, kwh, timestamp, verified }: MeterReadingRowProps) {
  const t = useTranslations('meterReadingRow')

  return (
    <tr key={id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40">
      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">{meter_id}</td>
      <td className="px-4 py-3 text-gray-900 dark:text-gray-100">{kwh.toFixed(3)}</td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
        {new Date(timestamp).toLocaleString()}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            verified
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
          }`}
        >
          {verified ? t('verified') : t('pending')}
        </span>
      </td>
    </tr>
  )
}