import { AlertTriangle, Bell, CheckCircle } from 'lucide-react'
import Link from 'next/link'
import { FiringAlert } from '@/lib/clickhouse'

interface AlertBannerProps {
  firingAlerts: FiringAlert[]
  totalConfigured: number
}

function formatMinutesAgo(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1m ago'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1h ago'
  return `${hours}h ago`
}

export function AlertBanner({ firingAlerts, totalConfigured }: AlertBannerProps) {
  const hasFiring = firingAlerts.length > 0

  if (totalConfigured === 0) {
    return (
      <div className="card-cannon border-cannon-graphite bg-cannon-steel/30 p-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cannon-graphite flex items-center justify-center">
              <Bell className="w-4 h-4 text-text-muted" />
            </div>
            <span className="text-text-secondary text-sm">
              No alerts configured
            </span>
          </div>
          <Link
            href="/alerts"
            className="text-sm text-cannon-fire hover:text-cannon-fire/80 transition-colors"
          >
            Set up alerts →
          </Link>
        </div>
      </div>
    )
  }

  if (!hasFiring) {
    return (
      <div className="card-cannon border-cannon-success/30 bg-cannon-success/5 p-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cannon-success/20 flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-cannon-success" />
            </div>
            <span className="text-cannon-success text-sm font-medium">
              All systems healthy
            </span>
            <span className="text-text-muted text-sm">
              · {totalConfigured} alert{totalConfigured !== 1 ? 's' : ''} configured
            </span>
          </div>
          <Link
            href="/alerts"
            className="text-sm text-text-secondary hover:text-cannon-fire transition-colors"
          >
            View alerts →
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-4 mb-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-cannon-critical/20 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-4 h-4 text-cannon-critical" />
          </div>
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-cannon-critical font-medium">
              {firingAlerts.length} alert{firingAlerts.length !== 1 ? 's' : ''} firing
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              {firingAlerts.slice(0, 3).map((alert) => (
                <Link
                  key={alert.id}
                  href={`/alerts?edit=${alert.id}`}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-cannon-critical/20 text-cannon-critical text-sm hover:bg-cannon-critical/30 transition-colors"
                >
                  <span className="font-mono truncate max-w-[150px]">{alert.name}</span>
                  <span className="text-cannon-critical/70 text-xs">
                    {formatMinutesAgo(alert.minutes_ago)}
                  </span>
                </Link>
              ))}
              {firingAlerts.length > 3 && (
                <span className="text-cannon-critical/70 text-sm">
                  +{firingAlerts.length - 3} more
                </span>
              )}
            </div>
          </div>
        </div>
        <Link
          href="/alerts"
          className="text-sm text-cannon-critical hover:text-cannon-critical/80 transition-colors flex-shrink-0"
        >
          View all alerts →
        </Link>
      </div>
    </div>
  )
}
