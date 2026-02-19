'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { LogList } from './LogList'
import { Radio, ChevronUp } from 'lucide-react'
import type { DestinationOption } from './LogRow'

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
  highlightedLogId?: string | null
}

export function LogExplorer({ initialLogs, highlightedLogId }: LogExplorerProps) {
  const searchParams = useSearchParams()
  const [logs, setLogs] = useState<LogEvent[]>(initialLogs)
  const [isTailing, setIsTailing] = useState(false)
  const [lastTimestamp, setLastTimestamp] = useState<string | null>(
    initialLogs.length > 0 ? initialLogs[0].timestamp : null
  )
  const [newLogIds, setNewLogIds] = useState<Set<string>>(new Set())
  const [newLogCount, setNewLogCount] = useState(0)
  const [isAtTop, setIsAtTop] = useState(true)
  const [destinations, setDestinations] = useState<DestinationOption[]>([])
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const logsRef = useRef<LogEvent[]>(initialLogs)

  // Check if viewing historical data (custom range with end date)
  const isHistoricalView = searchParams.has('to')

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

    // Copy time range params
    const time = searchParams.get('time')
    if (time) params.set('time', time)

    const from = searchParams.get('from')
    if (from) params.set('from', from)

    const to = searchParams.get('to')
    if (to) params.set('to', to)

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
        // Dedupe by ID using ref to avoid stale closure issues
        const existingIds = new Set(logsRef.current.map(l => l.id))
        const uniqueNewLogs = data.logs.filter((l: LogEvent) => !existingIds.has(l.id))

        // Only flash and add logs that are actually new
        if (uniqueNewLogs.length > 0) {
          const newIds = new Set<string>(uniqueNewLogs.map((l: LogEvent) => l.id))
          setNewLogIds(newIds)
          setTimeout(() => setNewLogIds(new Set()), 500)

          setLogs(prev => [...uniqueNewLogs, ...prev])

          // Track new logs for indicator if not at top
          if (!isAtTop) {
            setNewLogCount(prev => prev + uniqueNewLogs.length)
          }
        }

        setLastTimestamp(data.logs[0].timestamp)
      }
    } catch {
      // Silently fail - don't disrupt the UI
    }
  }, [buildQueryParams, isAtTop])

  // Keep logsRef in sync with logs state
  useEffect(() => {
    logsRef.current = logs
  }, [logs])

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

  // Disable tailing when viewing historical data
  useEffect(() => {
    if (isHistoricalView && isTailing) {
      setIsTailing(false)
    }
  }, [isHistoricalView, isTailing])

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

  // Fetch available destinations once
  useEffect(() => {
    fetch('/api/alert-destinations')
      .then(res => res.ok ? res.json() : [])
      .then((data: Array<{ id: string; name: string; type: string; enabled: number }>) => {
        setDestinations(
          data
            .filter(d => d.enabled)
            .map(d => ({ id: d.id, name: d.name, type: d.type }))
        )
      })
      .catch(() => {})
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
          disabled={isHistoricalView}
          title={isHistoricalView ? 'Tailing disabled for historical time ranges' : undefined}
          className={`
            flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all
            ${isTailing
              ? 'bg-cannon-tracer/20 text-cannon-tracer border border-cannon-tracer/30 animate-pulse-slow'
              : 'bg-cannon-steel text-text-secondary hover:text-text-primary hover:bg-cannon-graphite border border-cannon-graphite'
            }
            ${isHistoricalView ? 'opacity-50 cursor-not-allowed' : ''}
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

      <LogList logs={logsWithNewFlag} highlightedLogId={highlightedLogId} destinations={destinations} />
    </div>
  )
}
