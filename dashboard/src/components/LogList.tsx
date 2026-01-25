'use client'

import { useState, useMemo } from 'react'
import { LogRow } from './LogRow'
import { ColumnPicker } from './ColumnPicker'
import { useColumns } from '@/hooks/useColumns'
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

function extractPropertiesFromLogs(logs: Log[]): string[] {
  const propertySet = new Set<string>()

  for (const log of logs.slice(0, 100)) { // Limit to first 100 for performance
    try {
      const props = JSON.parse(log.properties)
      if (props && typeof props === 'object') {
        for (const key of Object.keys(props)) {
          propertySet.add(key)
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return Array.from(propertySet).sort()
}

export function LogList({ logs }: LogListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { columns, addColumn, removeColumn, toggleColumn, hasColumn, canAddMore, maxColumns } = useColumns()

  // Extract unique property names from logs for autocomplete
  const recentProperties = useMemo(() => extractPropertiesFromLogs(logs), [logs])

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
    <div>
      {/* Header with column picker */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-text-muted text-xs uppercase tracking-wide">
          Log Events
        </div>
        <ColumnPicker
          columns={columns}
          onRemove={removeColumn}
          onAdd={addColumn}
          recentProperties={recentProperties}
          canAddMore={canAddMore}
          maxColumns={maxColumns}
        />
      </div>

      {/* Log entries */}
      <div className="space-y-2">
        {logs.map(log => (
          <LogRow
            key={log.id}
            log={log}
            isExpanded={expandedId === log.id}
            onToggle={() => toggleExpanded(log.id)}
            columns={columns}
            onToggleColumn={toggleColumn}
            hasColumn={hasColumn}
          />
        ))}
      </div>
    </div>
  )
}
