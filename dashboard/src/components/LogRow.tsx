'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronRight, ChevronDown, Check, X, AlertTriangle } from 'lucide-react'

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
    const date = new Date(ts)
    return date.toLocaleString()
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

export function LogRow({ log, isExpanded, onToggle, isNew }: LogRowProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const properties = parseProperties(log.properties)
  const isErrorLevel = ['error', 'fatal'].includes(log.level.toLowerCase())

  const handleFilter = (key: string, value: unknown, exclude: boolean) => {
    const params = new URLSearchParams(searchParams.toString())
    const paramKey = exclude ? `prop.${key}!` : `prop.${key}`
    const oppositeKey = exclude ? `prop.${key}` : `prop.${key}!`

    // Remove opposite filter if exists
    params.delete(oppositeKey)

    // Set the new filter
    params.set(paramKey, String(value))

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
                      .map(([key, value]) => (
                        <tr key={key} className="border-b border-cannon-graphite/50 last:border-0 group">
                          <td className="py-2.5 pr-2 w-16 align-top">
                            {isFilterableValue(value) && (
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleFilter(key, value, false)
                                  }}
                                  className="p-1.5 text-text-muted hover:text-cannon-tracer hover:bg-cannon-steel rounded transition-colors touch-target"
                                  title={`Filter where ${key} = ${value}`}
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleFilter(key, value, true)
                                  }}
                                  className="p-1.5 text-text-muted hover:text-cannon-critical hover:bg-cannon-steel rounded transition-colors touch-target"
                                  title={`Filter where ${key} != ${value}`}
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 text-cannon-warning font-medium font-mono whitespace-nowrap align-top">
                            {key}
                          </td>
                          <td className="py-2.5 break-all align-top">
                            {formatValue(value)}
                          </td>
                        </tr>
                      ))}
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
