'use client'

import { useState } from 'react'
import { LogRow } from './LogRow'
import { FileText } from 'lucide-react'

interface Log {
  id: string
  timestamp: string
  level: string
  message: string
  source: string
  exception?: string
  properties: string
}

interface LogListProps {
  logs: Log[]
}

export function LogList({ logs }: LogListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const toggleExpanded = (id: string) => {
    setExpandedId(current => current === id ? null : id)
  }

  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-cannon-steel flex items-center justify-center mb-4">
          <FileText className="w-8 h-8 text-text-muted" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">No logs found</h3>
        <p className="text-text-secondary text-sm max-w-sm">
          Try adjusting your filters or time range to see more results.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {logs.map(log => (
        <LogRow
          key={log.id}
          log={log}
          isExpanded={expandedId === log.id}
          onToggle={() => toggleExpanded(log.id)}
        />
      ))}
    </div>
  )
}
