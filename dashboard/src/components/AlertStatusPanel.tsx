import Link from 'next/link'
import { Bell, BellRing, CheckCircle2, ChevronRight, Clock } from 'lucide-react'
import type { AlertWithStatus } from '@/lib/clickhouse'

interface AlertStatusPanelProps {
  alerts: AlertWithStatus[]
}

function formatRelativeTime(minutes: number | null): string {
  if (minutes === null) return 'Never triggered'
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const actionableConfig = {
  firing: {
    Icon: BellRing,
    rowBg: 'bg-cannon-critical/10 hover:bg-cannon-critical/15',
    iconColor: 'text-cannon-critical',
    timeColor: 'text-cannon-critical',
    pulse: true,
  },
  recent: {
    Icon: Clock,
    rowBg: 'hover:bg-cannon-steel/50',
    iconColor: 'text-cannon-warning',
    timeColor: 'text-cannon-warning',
    pulse: false,
  },
} as const

export function AlertStatusPanel({ alerts }: AlertStatusPanelProps) {
  if (alerts.length === 0) return null

  const firing = alerts.filter((a) => a.status === 'firing')
  const recent = alerts.filter((a) => a.status === 'recent')
  const okCount = alerts.filter((a) => a.status === 'ok').length
  const actionable = [...firing, ...recent]

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Bell className="w-5 h-5 text-cannon-fire" />
            Alert Status
          </h2>
          <div className="flex items-center gap-2 text-xs font-mono flex-wrap">
            {firing.length > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-cannon-critical/20 text-cannon-critical">
                {firing.length} firing
              </span>
            )}
            {recent.length > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-cannon-warning/20 text-cannon-warning">
                {recent.length} recent
              </span>
            )}
            {okCount > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-cannon-success/20 text-cannon-success">
                {okCount} OK
              </span>
            )}
          </div>
        </div>
        <Link
          href="/alerts"
          className="text-sm text-text-secondary hover:text-cannon-fire transition-colors flex items-center gap-1"
        >
          Manage alerts <ChevronRight className="w-4 h-4" />
        </Link>
      </div>

      {actionable.length === 0 ? (
        <div className="card-cannon border-cannon-success/30 bg-cannon-success/5 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-cannon-success flex-shrink-0" />
              <span className="text-cannon-success text-sm font-medium">All clear</span>
              <span className="text-text-muted text-sm truncate">
                {alerts.length} alert{alerts.length !== 1 ? 's' : ''} configured
              </span>
            </div>
            <Link
              href="/alerts"
              className="text-sm text-text-secondary hover:text-cannon-fire transition-colors flex-shrink-0"
            >
              View alerts
            </Link>
          </div>
        </div>
      ) : (
        <div className="card-cannon overflow-hidden">
          <div className="divide-y divide-cannon-graphite">
            {actionable.map((alert) => {
              const config = actionableConfig[alert.status as 'firing' | 'recent']
              const Icon = config.Icon
              return (
                <Link
                  key={alert.id}
                  href={`/alerts?highlight=${alert.id}`}
                  className={`flex items-center gap-3 px-4 py-2.5 transition-colors group ${config.rowBg}`}
                >
                  <Icon
                    className={`w-4 h-4 flex-shrink-0 ${config.iconColor} ${config.pulse ? 'animate-pulse' : ''}`}
                  />
                  <span className="flex-1 min-w-0 text-sm text-text-primary font-medium truncate group-hover:text-cannon-fire transition-colors">
                    {alert.name}
                  </span>
                  <span className={`text-xs font-mono flex-shrink-0 ${config.timeColor}`}>
                    {formatRelativeTime(alert.minutes_ago)}
                  </span>
                </Link>
              )
            })}
          </div>
          {okCount > 0 && (
            <div className="border-t border-cannon-graphite px-4 py-2 bg-cannon-steel/30">
              <Link
                href="/alerts"
                className="text-xs text-text-muted hover:text-cannon-fire transition-colors font-mono"
              >
                {okCount} OK
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
