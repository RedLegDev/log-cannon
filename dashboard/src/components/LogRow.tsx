'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronRight, ChevronDown, Check, X, AlertTriangle, Columns, MoreVertical, Copy, FileText, Link, Send, Mail, Globe, Loader2 } from 'lucide-react'
import { ColumnConfig } from '@/hooks/useColumns'

// ===== Expandable Text Component =====

interface ExpandableTextProps {
  text: string
  threshold?: number
  className?: string
  preformatted?: boolean
}

function ExpandableText({ text, threshold = 200, className = '', preformatted = false }: ExpandableTextProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const shouldTruncate = text.length > threshold

  if (!shouldTruncate) {
    return preformatted ? (
      <pre className={className}>{text}</pre>
    ) : (
      <span className={className}>{text}</span>
    )
  }

  const displayText = isExpanded ? text : text.slice(0, threshold - 50) + '...'
  const content = preformatted ? (
    <pre className={className}>{displayText}</pre>
  ) : (
    <span className={className}>{displayText}</span>
  )

  return (
    <span className="inline">
      {content}
      <button
        onClick={(e) => {
          e.stopPropagation()
          setIsExpanded(!isExpanded)
        }}
        className="ml-2 text-cannon-tracer hover:text-cannon-glow text-xs font-medium transition-colors"
      >
        {isExpanded ? 'Show less' : 'Show more'}
      </button>
    </span>
  )
}

// ===== Copy Toast Component =====

interface CopyToastProps {
  message: string
  onDone: () => void
}

function CopyToast({ message, onDone }: CopyToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2000)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <span className="text-cannon-tracer text-xs font-medium animate-fade-in">
      {message}
    </span>
  )
}

// ===== Format Log as Text Helper =====

function formatLogAsText(log: {
  timestamp: string
  level: string
  message: string
  source: string
  exception?: string
  properties: string
}): string {
  const lines: string[] = []

  // Header line
  lines.push(`[${log.timestamp}] ${log.level.toUpperCase()} - ${log.message}`)
  lines.push('')

  // Properties
  try {
    const props = JSON.parse(log.properties)
    if (props && typeof props === 'object') {
      Object.entries(props)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([key, value]) => {
          if (typeof value === 'object') {
            lines.push(`${key}: ${JSON.stringify(value, null, 2)}`)
          } else {
            lines.push(`${key}: ${value}`)
          }
        })
    }
  } catch {
    // Skip properties if can't parse
  }

  // Exception
  if (log.exception) {
    lines.push('')
    lines.push('Exception:')
    lines.push(log.exception)
  }

  return lines.join('\n')
}

export interface DestinationOption {
  id: string
  name: string
  type: string
}

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
  destinations?: DestinationOption[]
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

function tryParseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  // Only try to parse if it looks like JSON object
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function getNestedObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return tryParseJson(value)
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

    if (value.length > 200) {
      return (
        <ExpandableText text={value} threshold={200} className="text-text-code" />
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
  if (typeof value === 'string') return value
  if (typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'boolean') return value.toString()
  return '—'
}

function getNestedValue(properties: Record<string, unknown> | null, path: string): unknown {
  if (!properties) return undefined
  const parts = path.split('.')
  if (parts.length === 1) {
    return properties[parts[0]]
  }

  // For nested paths, try to get the first part and parse if it's a JSON string
  const firstPart = properties[parts[0]]
  if (firstPart === undefined || firstPart === null) return undefined

  // If first part is a JSON string, parse it and extract the nested value
  const parsed = tryParseJson(firstPart)
  if (parsed) {
    const restPath = parts.slice(1).join('.')
    return getNestedValue(parsed, restPath)
  }

  // If first part is an object, recursively get the value
  if (typeof firstPart === 'object' && !Array.isArray(firstPart)) {
    const restPath = parts.slice(1).join('.')
    return getNestedValue(firstPart as Record<string, unknown>, restPath)
  }

  return undefined
}

function getColumnTooltip(property: string, value: unknown): string {
  if (value === null || value === undefined) return `${property}: (no value)`
  return `${property}: ${String(value)}`
}

interface NestedPropertyRowProps {
  parentKey: string
  propKey: string
  value: unknown
  onFilter: (key: string, value: unknown, exclude: boolean) => void
  onToggleColumn?: (property: string) => void
  hasColumn?: (property: string) => boolean
}

function NestedPropertyRow({ parentKey, propKey, value, onFilter, onToggleColumn, hasColumn }: NestedPropertyRowProps) {
  const fullPath = `${parentKey}.${propKey}`
  const isColumn = hasColumn?.(fullPath) ?? false

  return (
    <tr className="border-b border-cannon-graphite/30 last:border-0 group bg-cannon-charcoal/30">
      <td className="py-2 pr-2 w-10 align-top pl-6">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <PropertyMenu
            property={fullPath}
            value={value}
            isColumn={isColumn}
            onToggleColumn={() => onToggleColumn?.(fullPath)}
            onFilter={(exclude) => onFilter(fullPath, value, exclude)}
            isFilterable={isFilterableValue(value)}
          />
        </div>
      </td>
      <td className="py-2 pr-4 text-cyan-400 font-medium font-mono whitespace-nowrap align-top text-xs">
        <span className="flex items-center gap-2">
          <span className="text-text-muted">{parentKey}.</span>{propKey}
          {isColumn && (
            <span title="Shown as column">
              <Columns size={12} className="text-text-muted" />
            </span>
          )}
        </span>
      </td>
      <td className="py-2 break-all align-top text-xs">
        {formatValue(value)}
      </td>
    </tr>
  )
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

// ===== Action Bar Component =====

interface ActionBarProps {
  log: {
    id: string
    timestamp: string
    level: string
    message: string
    source: string
    exception?: string
    properties: string
  }
  destinations?: DestinationOption[]
}

function ActionBar({ log, destinations }: ActionBarProps) {
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const sendRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sendOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (sendRef.current && !sendRef.current.contains(e.target as Node)) {
        setSendOpen(false)
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setSendOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [sendOpen])

  const copyAsJson = async () => {
    try {
      const logData = {
        id: log.id,
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
        source: log.source,
        exception: log.exception,
        properties: JSON.parse(log.properties),
      }
      await navigator.clipboard.writeText(JSON.stringify(logData, null, 2))
      setToastMessage('Copied as JSON')
    } catch {
      setToastMessage('Failed to copy')
    }
  }

  const copyAsText = async () => {
    try {
      await navigator.clipboard.writeText(formatLogAsText(log))
      setToastMessage('Copied as text')
    } catch {
      setToastMessage('Failed to copy')
    }
  }

  const copyShareLink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}?id=${log.id}`
      await navigator.clipboard.writeText(url)
      setToastMessage('Link copied')
    } catch {
      setToastMessage('Failed to copy')
    }
  }

  const sendToDestination = async (dest: DestinationOption) => {
    setSending(dest.id)
    try {
      const res = await fetch('/api/alert-destinations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination_id: dest.id,
          event: {
            id: log.id,
            timestamp: log.timestamp,
            level: log.level,
            message: log.message,
            source: log.source,
            exception: log.exception || '',
            properties: log.properties,
          },
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed (${res.status})`)
      }
      setToastMessage(`Sent to ${dest.name}`)
      setSendOpen(false)
    } catch (err) {
      setToastMessage(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(null)
    }
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-cannon-graphite bg-cannon-steel/30">
      <button
        onClick={(e) => {
          e.stopPropagation()
          copyAsJson()
        }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-cannon-steel rounded transition-colors"
        title="Copy as JSON"
      >
        <Copy size={14} />
        <span>JSON</span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          copyAsText()
        }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-cannon-steel rounded transition-colors"
        title="Copy as formatted text"
      >
        <FileText size={14} />
        <span>Text</span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          copyShareLink()
        }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-cannon-steel rounded transition-colors"
        title="Copy share link"
      >
        <Link size={14} />
        <span>Share</span>
      </button>

      {destinations && destinations.length > 0 && (
        <div ref={sendRef} className="relative ml-1 border-l border-cannon-graphite pl-2">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setSendOpen(!sendOpen)
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-secondary hover:text-cannon-fire hover:bg-cannon-steel rounded transition-colors"
            title="Send to destination"
          >
            <Send size={14} />
            <span>Send</span>
          </button>
          {sendOpen && (
            <div
              className="absolute top-full left-0 mt-1 min-w-[200px] py-1 bg-cannon-charcoal border border-cannon-graphite rounded-lg shadow-xl z-50"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-1.5 text-xs text-text-muted font-semibold uppercase tracking-wide border-b border-cannon-graphite">
                Send to
              </div>
              {destinations.map((dest) => (
                <button
                  key={dest.id}
                  onClick={() => sendToDestination(dest)}
                  disabled={sending !== null}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-cannon-steel transition-colors disabled:opacity-50"
                >
                  {sending === dest.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : dest.type === 'email' ? (
                    <Mail size={14} className="text-cannon-tracer" />
                  ) : (
                    <Globe size={14} className="text-cannon-fire" />
                  )}
                  <span>{dest.name}</span>
                  <span className={`ml-auto text-[10px] uppercase font-medium ${dest.type === 'email' ? 'text-cannon-tracer' : 'text-cannon-fire'}`}>
                    {dest.type}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {toastMessage && (
        <CopyToast message={toastMessage} onDone={() => setToastMessage(null)} />
      )}
    </div>
  )
}

export function LogRow({ log, isExpanded, onToggle, isNew, columns = [], onToggleColumn, hasColumn, destinations }: LogRowProps) {
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
                const value = getNestedValue(properties, col.property)
                const displayValue = formatColumnValue(value)
                const tooltip = getColumnTooltip(col.property, value)
                const isMissing = value === null || value === undefined

                return (
                  <span
                    key={col.property}
                    title={tooltip}
                    className={`
                      hidden md:inline-block text-xs px-2 py-0.5 rounded font-mono
                      ${isMissing
                        ? 'bg-cannon-graphite/50 text-text-muted italic'
                        : 'bg-cannon-steel text-text-secondary'
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
          {/* Action bar */}
          <ActionBar log={log} destinations={destinations} />

          {log.exception && (
            <div className="border-b border-cannon-graphite">
              <div className="px-4 py-2 bg-red-900/20 border-b border-red-900/30 flex items-center gap-2">
                <AlertTriangle className="text-cannon-critical" size={14} />
                <span className="text-red-400 text-xs font-semibold uppercase tracking-wide">Exception</span>
              </div>
              <div className="p-4 text-red-400 text-xs font-mono overflow-x-auto scrollbar-hide whitespace-pre-wrap">
                <ExpandableText text={log.exception} threshold={500} className="text-red-400" preformatted />
              </div>
            </div>
          )}

          {properties && Object.keys(properties).length > 0 && (
            <div className="p-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(properties)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .flatMap(([key, value]) => {
                        const isColumn = hasColumn?.(key) ?? false
                        const nestedJson = getNestedObject(value)
                        const rows: React.ReactNode[] = []

                        // Main property row
                        rows.push(
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
                                {nestedJson && (
                                  <span className="text-text-muted text-xs font-normal">(JSON object)</span>
                                )}
                                {isColumn && (
                                  <span title="Shown as column">
                                    <Columns size={12} className="text-text-muted" />
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="py-2.5 break-all align-top">
                              {nestedJson ? (
                                <span className="text-text-muted text-xs italic">Expanded below ↓</span>
                              ) : (
                                formatValue(value)
                              )}
                            </td>
                          </tr>
                        )

                        // Nested properties if value is a JSON string
                        if (nestedJson) {
                          Object.entries(nestedJson)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .forEach(([nestedKey, nestedValue]) => {
                              rows.push(
                                <NestedPropertyRow
                                  key={`${key}.${nestedKey}`}
                                  parentKey={key}
                                  propKey={nestedKey}
                                  value={nestedValue}
                                  onFilter={handleFilter}
                                  onToggleColumn={onToggleColumn}
                                  hasColumn={hasColumn}
                                />
                              )
                            })
                        }

                        return rows
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
