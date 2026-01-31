'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { LogRow } from './LogRow'
import { ColumnPicker } from './ColumnPicker'
import { useColumns } from '@/hooks/useColumns'
import { FileText, AlertCircle } from 'lucide-react'

interface Log {
  id: string
  timestamp: string
  level: string
  message: string
  source: string
  exception?: string
  properties: string
  isNew?: boolean
}

interface LogListProps {
  logs: Log[]
  highlightedLogId?: string | null
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

export function LogList({ logs, highlightedLogId }: LogListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(highlightedLogId || null)
  const [highlightedId, setHighlightedId] = useState<string | null>(highlightedLogId || null)
  const { columns, addColumn, removeColumn, toggleColumn, hasColumn, canAddMore, maxColumns } = useColumns()
  const logRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const hasScrolledToHighlight = useRef(false)

  // Extract unique property names from logs for autocomplete
  const recentProperties = useMemo(() => extractPropertiesFromLogs(logs), [logs])

  // Handle highlighted log - scroll to it and apply highlight
  useEffect(() => {
    if (highlightedLogId && !hasScrolledToHighlight.current) {
      // Wait for render
      const timeoutId = setTimeout(() => {
        const logElement = logRefs.current.get(highlightedLogId)
        if (logElement) {
          logElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setExpandedId(highlightedLogId)
          hasScrolledToHighlight.current = true

          // Remove highlight after animation
          setTimeout(() => {
            setHighlightedId(null)
          }, 3000)
        }
      }, 100)
      return () => clearTimeout(timeoutId)
    }
  }, [highlightedLogId, logs])

  const setLogRef = (id: string, element: HTMLDivElement | null) => {
    if (element) {
      logRefs.current.set(id, element)
    } else {
      logRefs.current.delete(id)
    }
  }

  // Check if highlighted log exists in current logs (only check if we have logs loaded)
  const highlightedLogExists = !highlightedLogId || logs.length === 0 || logs.some(log => log.id === highlightedLogId)

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
      {/* Log not found warning */}
      {highlightedLogId && !highlightedLogExists && (
        <div className="mb-4 card-cannon border-cannon-warning/50 bg-cannon-warning/10 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cannon-warning flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-cannon-warning">Log entry not found</h3>
              <p className="text-text-secondary text-sm mt-1">
                The linked log entry may have been deleted or is outside the current time range.
              </p>
            </div>
          </div>
        </div>
      )}

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
          <div
            key={log.id}
            ref={(el) => setLogRef(log.id, el)}
            className={highlightedId === log.id ? 'animate-highlight-glow' : ''}
          >
            <LogRow
              log={log}
              isExpanded={expandedId === log.id}
              onToggle={() => toggleExpanded(log.id)}
              isNew={log.isNew}
              columns={columns}
              onToggleColumn={toggleColumn}
              hasColumn={hasColumn}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
