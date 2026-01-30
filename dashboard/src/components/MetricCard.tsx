import { LucideIcon } from 'lucide-react'

interface SparklineProps {
  data: number[]
  color?: string
  height?: number
}

function Sparkline({ data, color = 'cannon-fire', height = 32 }: SparklineProps) {
  if (data.length === 0) return null

  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1

  return (
    <div className="flex items-end gap-px" style={{ height }}>
      {data.map((value, i) => {
        const barHeight = ((value - min) / range) * 100
        return (
          <div
            key={i}
            className={`flex-1 bg-${color}/60 rounded-sm transition-all hover:bg-${color}`}
            style={{ height: `${Math.max(barHeight, 2)}%`, minHeight: value > 0 ? '2px' : '0' }}
          />
        )
      })}
    </div>
  )
}

type ColorVariant = 'fire' | 'critical' | 'warning' | 'tracer' | 'success'

interface MetricCardProps {
  icon: LucideIcon
  label: string
  value: string | number
  secondaryText?: string
  secondaryLink?: string
  trend?: {
    value: number
    label?: string
  }
  sparkline?: number[]
  color?: ColorVariant
  onClick?: () => void
}

const colorMap: Record<ColorVariant, { border: string; bg: string; text: string; icon: string }> = {
  fire: {
    border: 'hover:border-cannon-fire/50',
    bg: 'group-hover:bg-cannon-fire/20',
    text: 'text-text-primary',
    icon: 'text-cannon-fire'
  },
  critical: {
    border: 'hover:border-cannon-critical/50',
    bg: 'group-hover:bg-cannon-critical/20',
    text: 'text-cannon-critical',
    icon: 'text-cannon-critical'
  },
  warning: {
    border: 'hover:border-cannon-warning/50',
    bg: 'group-hover:bg-cannon-warning/20',
    text: 'text-cannon-warning',
    icon: 'text-cannon-warning'
  },
  tracer: {
    border: 'hover:border-cannon-tracer/50',
    bg: 'group-hover:bg-cannon-tracer/20',
    text: 'text-cannon-tracer',
    icon: 'text-cannon-tracer'
  },
  success: {
    border: 'hover:border-cannon-success/50',
    bg: 'group-hover:bg-cannon-success/20',
    text: 'text-cannon-success',
    icon: 'text-cannon-success'
  }
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  secondaryText,
  secondaryLink,
  trend,
  sparkline,
  color = 'fire',
  onClick
}: MetricCardProps) {
  const colors = colorMap[color]

  return (
    <div
      className={`card-cannon p-5 group ${colors.border} transition-all ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-10 h-10 rounded-lg bg-cannon-steel flex items-center justify-center ${colors.bg} transition-colors`}>
          <Icon className={`w-5 h-5 ${colors.icon}`} />
        </div>
        <span className="text-text-secondary text-sm">{label}</span>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className={`text-3xl font-bold font-mono tabular-nums ${colors.text}`}>
            {typeof value === 'number' ? value.toLocaleString() : value}
          </div>

          {secondaryText && (
            <div className="text-sm text-text-secondary mt-1">
              {secondaryLink ? (
                <a href={secondaryLink} className="hover:text-cannon-fire transition-colors">
                  {secondaryText}
                </a>
              ) : (
                secondaryText
              )}
            </div>
          )}

          {trend && (
            <div className={`text-sm mt-1 flex items-center gap-1 ${trend.value > 0 ? 'text-cannon-success' : trend.value < 0 ? 'text-cannon-critical' : 'text-text-muted'}`}>
              {trend.value > 0 ? '↑' : trend.value < 0 ? '↓' : '→'}
              <span className="font-mono tabular-nums">{Math.abs(trend.value)}%</span>
              {trend.label && <span className="text-text-muted">{trend.label}</span>}
            </div>
          )}
        </div>

        {sparkline && sparkline.length > 0 && (
          <div className="w-24 flex-shrink-0">
            <Sparkline data={sparkline} color={`cannon-${color}`} />
          </div>
        )}
      </div>
    </div>
  )
}
