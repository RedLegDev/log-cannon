'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Play, Pause, Trash2, Radio, AlertTriangle, ChevronDown } from 'lucide-react'

interface LogEvent {
  id: string
  timestamp: string
  level: string
  message: string
  source: string
  exception: string
  properties: string
}

function getLevelClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'debug': return 'text-text-muted'
    case 'information': return 'text-blue-400'
    case 'warning': return 'text-cannon-warning'
    case 'error': return 'text-cannon-critical'
    case 'fatal': return 'text-cannon-critical font-bold'
    default: return 'text-text-muted'
  }
}

function getLevelBg(level: string): string {
  switch (level.toLowerCase()) {
    case 'debug': return ''
    case 'information': return ''
    case 'warning': return 'bg-cannon-warning/5'
    case 'error': return 'bg-cannon-critical/5'
    case 'fatal': return 'bg-cannon-critical/10'
    default: return ''
  }
}

function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts)
    return date.toLocaleTimeString()
  } catch {
    return ts
  }
}

export default function LiveTailPage() {
  const [logs, setLogs] = useState<LogEvent[]>([])
  const [isRunning, setIsRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastTimestamp, setLastTimestamp] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const [newLogIds, setNewLogIds] = useState<Set<string>>(new Set())

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (lastTimestamp) {
        params.set('since', lastTimestamp)
      }

      const response = await fetch(`/api/logs/live?${params.toString()}`)
      if (!response.ok) throw new Error('Failed to fetch logs')

      const data = await response.json()
      if (data.logs && data.logs.length > 0) {
        const newIds = new Set<string>(data.logs.map((l: LogEvent) => l.id))
        setNewLogIds(newIds)
        setTimeout(() => setNewLogIds(new Set()), 500)

        setLogs(prev => [...data.logs, ...prev].slice(0, 500))
        setLastTimestamp(data.logs[0].timestamp)
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch logs')
    }
  }, [lastTimestamp])

  useEffect(() => {
    if (!isRunning) return

    fetchLogs()
    const interval = setInterval(fetchLogs, 2000)
    return () => clearInterval(interval)
  }, [isRunning, fetchLogs])

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = 0
    }
  }, [logs, autoScroll])

  const handleScroll = () => {
    if (containerRef.current) {
      const { scrollTop } = containerRef.current
      setAutoScroll(scrollTop < 100)
    }
  }

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary font-mono flex items-center gap-3">
            <span>Live</span>
            <span className="text-cannon-fire">Tail</span>
            {isRunning && (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cannon-tracer opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-cannon-tracer"></span>
              </span>
            )}
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            Real-time log streaming • {logs.length} logs buffered
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Status Indicator */}
          <div className={`
            flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium
            ${isRunning ? 'bg-cannon-tracer/20 text-cannon-tracer' : 'bg-cannon-graphite text-text-muted'}
          `}>
            <Radio className="w-4 h-4" />
            {isRunning ? 'Streaming' : 'Paused'}
          </div>

          {/* Controls */}
          <button
            onClick={() => setIsRunning(!isRunning)}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all
              ${isRunning
                ? 'bg-cannon-critical/20 text-cannon-critical hover:bg-cannon-critical/30 border border-cannon-critical/30'
                : 'bg-cannon-tracer/20 text-cannon-tracer hover:bg-cannon-tracer/30 border border-cannon-tracer/30'
              }
            `}
          >
            {isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            <span className="hidden sm:inline">{isRunning ? 'Pause' : 'Resume'}</span>
          </button>

          <button
            onClick={() => {
              setLogs([])
              setLastTimestamp(null)
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium btn-cannon-secondary"
          >
            <Trash2 className="w-4 h-4" />
            <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-3 mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-cannon-critical flex-shrink-0" />
            <span className="text-cannon-critical text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* Terminal */}
      <div className="flex-1 card-cannon overflow-hidden flex flex-col bg-cannon-black">
        {/* Terminal Header */}
        <div className="flex items-center gap-2 px-4 py-2 bg-cannon-steel border-b border-cannon-graphite">
          <div className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full bg-cannon-critical/80"></span>
            <span className="w-3 h-3 rounded-full bg-cannon-warning/80"></span>
            <span className="w-3 h-3 rounded-full bg-cannon-tracer/80"></span>
          </div>
          <span className="text-text-muted text-xs font-mono ml-2">live-tail</span>
        </div>

        {/* Log Content */}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto font-mono text-sm scrollbar-hide"
        >
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="w-16 h-16 rounded-full bg-cannon-steel flex items-center justify-center mb-4">
                <Radio className="w-8 h-8 text-text-muted" />
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">Waiting for logs...</h3>
              <p className="text-text-secondary text-sm">
                New logs will appear here in real-time.
              </p>
            </div>
          ) : (
            <table className="w-full">
              <tbody>
                {logs.map(log => (
                  <tr
                    key={log.id}
                    className={`
                      border-b border-cannon-graphite/30 hover:bg-cannon-steel/30 transition-colors
                      ${getLevelBg(log.level)}
                      ${newLogIds.has(log.id) ? 'animate-flash' : ''}
                    `}
                  >
                    <td className="px-3 py-1.5 text-text-muted whitespace-nowrap w-24 tabular-nums">
                      {formatTimestamp(log.timestamp)}
                    </td>
                    <td className={`px-2 py-1.5 whitespace-nowrap w-16 text-center ${getLevelClass(log.level)}`}>
                      <span className="px-1.5 py-0.5 rounded text-xs font-semibold uppercase">
                        {log.level.substring(0, 4)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-text-secondary whitespace-nowrap w-32 truncate max-w-[8rem]">
                      {log.source}
                    </td>
                    <td className="px-2 py-1.5 text-text-primary">
                      <span className="line-clamp-1">{log.message}</span>
                      {log.exception && (
                        <span className="text-cannon-critical ml-2 text-xs">[Exception]</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Scroll to Top Button */}
        {!autoScroll && logs.length > 0 && (
          <button
            onClick={() => {
              if (containerRef.current) {
                containerRef.current.scrollTop = 0
                setAutoScroll(true)
              }
            }}
            className="absolute bottom-20 right-8 p-3 rounded-full bg-cannon-fire text-white shadow-fire hover:bg-cannon-ember transition-all"
          >
            <ChevronDown className="w-5 h-5 rotate-180" />
          </button>
        )}
      </div>
    </div>
  )
}
