'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronRight, ChevronDown, Check, X } from 'lucide-react'

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
  if (value === null) return <span className="text-gray-500 italic">null</span>
  if (value === undefined) return <span className="text-gray-500 italic">undefined</span>

  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'text-green-400' : 'text-red-400'}>
        {value.toString()}
      </span>
    )
  }

  if (typeof value === 'number') {
    return (
      <span className="text-purple-400 tabular-nums">
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
          className="text-cyan-400 hover:text-cyan-300 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {value}
        </a>
      )
    }

    if (value.length > 100) {
      return (
        <span title={value} className="text-gray-300">
          {value.slice(0, 100)}
          <span className="text-gray-500">...</span>
        </span>
      )
    }

    return <span className="text-gray-300">{value}</span>
  }

  if (typeof value === 'object') {
    return (
      <span className="text-gray-500 font-mono text-xs">
        {JSON.stringify(value)}
      </span>
    )
  }

  return <span className="text-gray-300">{String(value)}</span>
}

function isFilterableValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export function LogRow({ log, isExpanded, onToggle }: LogRowProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const properties = parseProperties(log.properties)

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
      className={`bg-gray-800 rounded border transition-colors ${
        isExpanded ? 'border-gray-600' : 'border-gray-700 hover:border-gray-600'
      }`}
    >
      <div
        className="p-4 cursor-pointer select-none"
        onClick={onToggle}
      >
        <div className="flex items-start gap-3">
          <div className="text-gray-500 mt-0.5">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
          <div className="flex-grow min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-gray-500 text-sm">{formatTimestamp(log.timestamp)}</span>
              <span className={`font-medium ${getLevelClass(log.level)}`}>{log.level}</span>
              <span className="text-gray-400 text-sm">{log.source}</span>
            </div>
            <div className="text-white font-mono text-sm truncate">{log.message}</div>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-gray-700 bg-gray-850">
          {log.exception && (
            <pre className="p-4 text-red-400 text-xs bg-gray-900 overflow-x-auto border-b border-gray-700">
              {log.exception}
            </pre>
          )}

          {properties && Object.keys(properties).length > 0 && (
            <div className="p-4">
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(properties)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, value]) => (
                      <tr key={key} className="border-b border-gray-700 last:border-0">
                        <td className="py-2 pr-2 w-8">
                          {isFilterableValue(value) && (
                            <div className="flex gap-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleFilter(key, value, false)
                                }}
                                className="p-1 text-gray-500 hover:text-green-400 hover:bg-gray-700 rounded"
                                title={`Filter where ${key} = ${value}`}
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleFilter(key, value, true)
                                }}
                                className="p-1 text-gray-500 hover:text-red-400 hover:bg-gray-700 rounded"
                                title={`Filter where ${key} != ${value}`}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-yellow-500 font-medium whitespace-nowrap">
                          {key}
                        </td>
                        <td className="py-2 break-all">
                          {formatValue(value)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {!properties && !log.exception && (
            <div className="p-4 text-gray-500 text-sm italic">
              No additional properties
            </div>
          )}
        </div>
      )}
    </div>
  )
}
