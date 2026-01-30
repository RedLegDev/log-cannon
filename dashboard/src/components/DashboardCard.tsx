import Link from 'next/link'
import { LayoutDashboard } from 'lucide-react'

interface DashboardCardProps {
  name: string
  description: string
}

export function DashboardCard({ name, description }: DashboardCardProps) {
  return (
    <Link
      href={`/dashboards/${name}`}
      className="block card-cannon p-4 border-cannon-graphite hover:border-cannon-fire/50 transition-all group"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-cannon-fire/10 flex items-center justify-center flex-shrink-0">
          <LayoutDashboard className="w-5 h-5 text-cannon-fire" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-text-primary font-medium text-sm truncate group-hover:text-cannon-fire transition-colors">
            {name}
          </h3>
          {description && (
            <p className="text-text-muted text-xs truncate mt-1">
              {description}
            </p>
          )}
        </div>
      </div>
    </Link>
  )
}
