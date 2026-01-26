'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronRight, ChevronDown, Check, X, AlertTriangle, Columns, MoreVertical } from 'lucide-react'
import { ColumnConfig } from '@/hooks/useColumns'

interface LogRowProps {
  log: {
    id: string
    timestamp: string
    level: string
    message: string
    source: string
    exception?: string
    properties: string
  }
  isExpanded: boolean
  onToggle: () => void
  isNew?: boolean
  columns?: ColumnConfig[]
  onToggleColumn?: (property: string) => void
  hasColumn?: (property: string) => boolean
}

function getLevelClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'debug': return 'log-level-debug'
    case 'information': return 'log-level-information'
    case 'warning': return 'log-level-warning'
    case 'error': return 'log-level-error'
    case 'fatal': return 'log-level-fatal'
    default: return 'text-gray-400'
  }
}

function getLevelBorderClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'debug': return 'border-l-gray-500'
    case 'information': return 'border-l-blue-500'
    case 'warning': return 'border-l-amber-500'
    case 'error': return 'border-l-red-500'
    case 'fatal': return 'border-l-red-600'
    default: return 'border-l-gray-600'
  }
}

function formatTimestamp(ts: string): string {
  try {
    // Timestamps from ClickHouse are in UTC but without timezone suffix
    // Convert to ISO format with Z suffix so JS parses as UTC
    const isoString = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z'
    const date = new Date(isoString)
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return ts
  }
}

function parseProperties(props: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(props)
    if (Object.keys(parsed).length === 0) return null
    return parsed
  } catch {
    return null
  }
}

function isUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function formatValue(value: unknown): React.ReactNode {
  if (value === null) return <span className="text-text-muted italic">null</span>
  if (value === undefined) return <span className="text-text-muted italic">undefined</span>

  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'text-cannon-tracer' : 'text-cannon-critical'}>
        {value.toString()}
      </span>
    )
  }

  if (typeof value === 'number') {
    return (
      <span className="text-purple-400 tabular-nums font-mono">
        {value.toLocaleString()}
      </span>
    )
  }

  if (typeof value === 'string') {
    if (isUrl(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-400 hover:text-cyan-300 hover:underline transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {value}
        </a>
      )
    }

    if (value.length > 100) {
      return (
        <span title={value} className="text-text-code">
          {value.slice(0, 100)}
          <span className="text-text-muted">...</span>
        </span>
      )
    }

    return <span className="text-text-code">{value}</span>
  }

  if (typeof value === 'object') {
    return (
      <span className="text-text-muted font-mono text-xs">
        {JSON.stringify(value)}
      </span>
    )
  }

  return <span className="text-text-code">{String(value)}</span>
}

function isFilterableValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function formatColumnValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    if (value.length > 15) return value.slice(0, 15) + '…'
    return value
  }
  if (typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'boolean') return value.toString()
  return '—'
}

function getColumnTooltip(property: string, value: unknown): string {
  if (value === null || value === undefined) return `${property}: (no value)`
  return `${property}: ${String(value)}`
}

interface PropertyMenuProps {
  property: string
  value: unknown
  isColumn: boolean
  onToggleColumn: () => void
  onFilter: (exclude: boolean) => void
  isFilterable: boolean
}

function PropertyMenu({ property, value, isColumn, onToggleColumn, onFilter, isFilterable }: PropertyMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setIsOpen(!isOpen)
        }}
        className="p-1.5 text-text-muted hover:text-text-secondary hover:bg-cannon-steel rounded transition-colors"
        title="Property actions"
      >
        <MoreVertical size={14} />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-48 bg-cannon-charcoal border border-cannon-graphite rounded-lg shadow-cannon z-50 overflow-hidden animate-slide-down">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleColumn()
              setIsOpen(false)
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-cannon-steel transition-colors"
          >
            <Columns size={14} />
            {isColumn ? 'Remove column' : 'Show as column'}
          </button>

          {isFilterable && (
            <>
              <div className="border-t border-cannon-graphite" />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onFilter(false)
                  setIsOpen(false)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-cannon-steel transition-colors"
              >
                <Check size={14} className="text-cannon-tracer" />
                Find this value
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onFilter(true)
                  setIsOpen(false)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-cannon-steel transition-colors"
              >
                <X size={14} className="text-cannon-critical" />
                Exclude this value
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function LogRow({ log, isExpanded, onToggle, isNew, columns = [], onToggleColumn, hasColumn }: LogRowProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const properties = parseProperties(log.properties)
  const isErrorLevel = ['error', 'fatal'].includes(log.level.toLowerCase())

  const handleFilter = (key: string, value: unknown, exclude: boolean) => {
    const params = new URLSearchParams(searchParams.toString())
    const paramKey = `prop.${key}`

    // Set the new filter with operator prefix in value
    const filterValue = exclude ? `!=${String(value)}` : String(value)
    params.set(paramKey, filterValue)

    router.push(`?${params.toString()}`)
  }

  return (
    <div
      className={`
        card-cannon border-l-4 transition-all duration-200
        ${getLevelBorderClass(log.level)}
        ${isExpanded ? 'border-cannon-slate shadow-cannon' : 'hover:border-cannon-slate hover:shadow-cannon hover:-translate-y-0.5'}
        ${isNew ? 'animate-flash' : ''}
      `}
    >
      <div
        className="p-4 cursor-pointer select-none"
        onClick={onToggle}
      >
        <div className="flex items-start gap-3">
          <div className="text-text-muted mt-0.5 transition-transform duration-200">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
          <div className="flex-grow min-w-0">
            <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-1.5">
              <span className="text-text-muted text-xs md:text-sm font-mono tabular-nums">
                {formatTimestamp(log.timestamp)}
              </span>
              <span className={`
                px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide
                ${log.level.toLowerCase() === 'debug' ? 'bg-gray-700/50 text-gray-400' : ''}
                ${log.level.toLowerCase() === 'information' ? 'bg-blue-900/50 text-blue-400' : ''}
                ${log.level.toLowerCase() === 'warning' ? 'bg-amber-900/50 text-amber-400' : ''}
                ${log.level.toLowerCase() === 'error' ? 'bg-red-900/50 text-red-400' : ''}
                ${log.level.toLowerCase() === 'fatal' ? 'bg-red-900/70 text-red-300 animate-pulse' : ''}
              `}>
                {log.level}
              </span>
              <span className="text-text-secondary text-xs md:text-sm px-2 py-0.5 bg-cannon-steel rounded">
                {log.source}
              </span>
              {/* Dynamic columns */}
              {columns.map((col) => {
                const value = properties?.[col.property]
                const displayValue = formatColumnValue(value)
                const tooltip = getColumnTooltip(col.property, value)
                const isMissing = value === null || value === undefined

                return (
                  <span
                    key={col.property}
                    title={tooltip}
                    className={`
                      hidden md:inline-block text-xs px-2 py-0.5 rounded font-mono truncate max-w-[120px]
                      ${isMissing
                        ? 'bg-cannon-graphite/50 text-text-muted italic'
                        : 'bg-cannon-steel text-text-code'
                      }
                    `}
                  >
                    {displayValue}
                  </span>
                )
              })}
            </div>
            <div className="text-text-primary font-mono text-sm leading-relaxed line-clamp-2 md:line-clamp-1">
              {log.message}
            </div>
          </div>
          {isErrorLevel && !isExpanded && (
            <AlertTriangle className="text-cannon-critical flex-shrink-0 mt-1" size={16} />
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-cannon-graphite bg-cannon-black/50 animate-slide-down">
          {log.exception && (
            <div className="border-b border-cannon-graphite">
              <div className="px-4 py-2 bg-red-900/20 border-b border-red-900/30 flex items-center gap-2">
                <AlertTriangle className="text-cannon-critical" size={14} />
                <span className="text-red-400 text-xs font-semibold uppercase tracking-wide">Exception</span>
              </div>
              <pre className="p-4 text-red-400 text-xs font-mono overflow-x-auto scrollbar-hide">
                {log.exception}
              </pre>
            </div>
          )}

          {properties && Object.keys(properties).length > 0 && (
            <div className="p-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(properties)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([key, value]) => {
                        const isColumn = hasColumn?.(key) ?? false
                        return (
                          <tr key={key} className="border-b border-cannon-graphite/50 last:border-0 group">
                            <td className="py-2.5 pr-2 w-10 align-top">
                              <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                <PropertyMenu
                                  property={key}
                                  value={value}
                                  isColumn={isColumn}
                                  onToggleColumn={() => onToggleColumn?.(key)}
                                  onFilter={(exclude) => handleFilter(key, value, exclude)}
                                  isFilterable={isFilterableValue(value)}
                                />
                              </div>
                            </td>
                            <td className="py-2.5 pr-4 text-cannon-warning font-medium font-mono whitespace-nowrap align-top">
                              <span className="flex items-center gap-2">
                                {key}
                                {isColumn && (
                                  <span title="Shown as column">
                                    <Columns size={12} className="text-text-muted" />
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="py-2.5 break-all align-top">
                              {formatValue(value)}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!properties && !log.exception && (
            <div className="p-4 text-text-muted text-sm italic">
              No additional properties
            </div>
          )}
        </div>
      )}
    </div>
  )
}
