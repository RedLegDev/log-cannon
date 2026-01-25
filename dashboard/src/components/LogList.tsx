'use client'

import { useState } from 'react'
import { LogRow } from './LogRow'

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
