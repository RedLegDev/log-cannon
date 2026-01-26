'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { LogList } from './LogList'
import { Radio, ChevronUp } from 'lucide-react'

interface LogEvent {
  id: string
  timestamp: string
  level: string
  message: string
  source: string
  exception?: string
  properties: string
}

interface LogExplorerProps {
  initialLogs: LogEvent[]
}

export function LogExplorer({ initialLogs }: LogExplorerProps) {
  const searchParams = useSearchParams()
  const [logs, setLogs] = useState<LogEvent[]>(initialLogs)
  const [isTailing, setIsTailing] = useState(false)
  const [lastTimestamp, setLastTimestamp] = useState<string | null>(
    initialLogs.length > 0 ? initialLogs[0].timestamp : null
  )
  const [newLogIds, setNewLogIds] = useState<Set<string>>(new Set())
  const [newLogCount, setNewLogCount] = useState(0)
  const [isAtTop, setIsAtTop] = useState(true)
  const topSentinelRef = useRef<HTMLDivElement>(null)

  // Build query string from current search params for the live API
  const buildQueryParams = useCallback(() => {
    const params = new URLSearchParams()

    if (lastTimestamp) {
      params.set('since', lastTimestamp)
    }

    const source = searchParams.get('source')
    if (source) params.set('source', source)

    const level = searchParams.get('level')
    if (level) params.set('level', level)

    const search = searchParams.get('search')
    if (search) params.set('search', search)

    // Copy property filters
    searchParams.forEach((value, key) => {
      if (key.startsWith('prop.')) {
        params.set(key, value)
      }
    })

    return params.toString()
  }, [searchParams, lastTimestamp])

  // Fetch new logs
  const fetchNewLogs = useCallback(async () => {
    try {
      const queryString = buildQueryParams()
      const response = await fetch(`/api/logs/live?${queryString}`)
      if (!response.ok) return

      const data = await response.json()
      if (data.logs && data.logs.length > 0) {
        const newIds = new Set<string>(data.logs.map((l: LogEvent) => l.id))
        setNewLogIds(newIds)
        setTimeout(() => setNewLogIds(new Set()), 500)

        setLogs(prev => {
          // Dedupe by ID
          const existingIds = new Set(prev.map(l => l.id))
          const uniqueNewLogs = data.logs.filter((l: LogEvent) => !existingIds.has(l.id))
          return [...uniqueNewLogs, ...prev]
        })

        setLastTimestamp(data.logs[0].timestamp)

        // Track new logs for indicator if not at top
        if (!isAtTop) {
          setNewLogCount(prev => prev + data.logs.length)
        }
      }
    } catch {
      // Silently fail - don't disrupt the UI
    }
  }, [buildQueryParams, isAtTop])

  // Polling effect
  useEffect(() => {
    if (!isTailing) return

    const interval = setInterval(fetchNewLogs, 2000)
    // Fetch immediately when starting
    fetchNewLogs()

    return () => clearInterval(interval)
  }, [isTailing, fetchNewLogs])

  // Reset logs when search params change (new search)
  useEffect(() => {
    setLogs(initialLogs)
    setLastTimestamp(initialLogs.length > 0 ? initialLogs[0].timestamp : null)
    setNewLogCount(0)
  }, [initialLogs])

  // Intersection observer for scroll detection
  useEffect(() => {
    if (!topSentinelRef.current) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsAtTop(entry.isIntersecting)
        if (entry.isIntersecting) {
          setNewLogCount(0)
        }
      },
      { threshold: 0 }
    )

    observer.observe(topSentinelRef.current)
    return () => observer.disconnect()
  }, [])

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    setNewLogCount(0)
  }

  // Add isNew flag to logs
  const logsWithNewFlag = logs.map(log => ({
    ...log,
    isNew: newLogIds.has(log.id)
  }))

  return (
    <div className="relative">
      {/* Sentinel for scroll detection */}
      <div ref={topSentinelRef} className="absolute top-0 h-1 w-full" />

      {/* Results count and tail toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-text-secondary text-sm">
          {logs.length > 0 && (
            <>Showing <span className="text-text-primary font-medium">{logs.length}</span> logs</>
          )}
        </div>

        <button
          onClick={() => setIsTailing(!isTailing)}
          className={`
            flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all
            ${isTailing
              ? 'bg-cannon-tracer/20 text-cannon-tracer border border-cannon-tracer/30 animate-pulse-slow'
              : 'bg-cannon-steel text-text-secondary hover:text-text-primary hover:bg-cannon-graphite border border-cannon-graphite'
            }
          `}
        >
          <Radio className="w-4 h-4" />
          {isTailing ? 'Tailing...' : 'Tail'}
        </button>
      </div>

      {/* New logs indicator */}
      {newLogCount > 0 && !isAtTop && (
        <button
          onClick={scrollToTop}
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-full bg-cannon-fire text-white shadow-fire hover:bg-cannon-ember transition-all animate-slide-down"
        >
          <ChevronUp className="w-4 h-4" />
          {newLogCount} new log{newLogCount !== 1 ? 's' : ''}
        </button>
      )}

      <LogList logs={logsWithNewFlag} />
    </div>
  )
}
