import Link from 'next/link'
import { Bell, BellRing, CheckCircle2, Clock } from 'lucide-react'
import type { AlertStatus } from '@/lib/clickhouse'

interface AlertStatusCardProps {
  id: string
  name: string
  description: string
  status: AlertStatus
  minutesAgo: number | null
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

const statusConfig = {
  firing: {
    border: 'border-cannon-critical/50',
    bg: 'bg-cannon-critical/10',
    iconBg: 'bg-cannon-critical/20',
    iconColor: 'text-cannon-critical',
    textColor: 'text-cannon-critical',
    Icon: BellRing,
    label: 'Firing'
  },
  recent: {
    border: 'border-cannon-warning/50',
    bg: 'bg-cannon-warning/5',
    iconBg: 'bg-cannon-warning/20',
    iconColor: 'text-cannon-warning',
    textColor: 'text-cannon-warning',
    Icon: Clock,
    label: 'Recent'
  },
  ok: {
    border: 'border-cannon-success/30',
    bg: 'bg-cannon-success/5',
    iconBg: 'bg-cannon-success/20',
    iconColor: 'text-cannon-success',
    textColor: 'text-cannon-success',
    Icon: CheckCircle2,
    label: 'OK'
  }
}

export function AlertStatusCard({ id, name, description, status, minutesAgo }: AlertStatusCardProps) {
  const config = statusConfig[status]
  const Icon = config.Icon

  return (
    <Link
      href={`/alerts?highlight=${id}`}
      className={`block card-cannon p-4 ${config.border} ${config.bg} hover:border-cannon-fire/50 transition-all group`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-lg ${config.iconBg} flex items-center justify-center flex-shrink-0`}>
          <Icon className={`w-5 h-5 ${config.iconColor} ${status === 'firing' ? 'animate-pulse' : ''}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-text-primary font-medium text-sm truncate group-hover:text-cannon-fire transition-colors">
              {name}
            </h3>
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${config.iconBg} ${config.textColor}`}>
              {config.label}
            </span>
          </div>
          {description && (
            <p className="text-text-muted text-xs truncate mb-1">
              {description}
            </p>
          )}
          <p className={`text-xs font-mono ${status === 'ok' && minutesAgo === null ? 'text-text-muted' : config.textColor}`}>
            {formatRelativeTime(minutesAgo)}
          </p>
        </div>
      </div>
    </Link>
  )
}
