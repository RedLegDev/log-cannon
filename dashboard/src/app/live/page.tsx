'use client'

import { useEffect, useState, useCallback } from 'react'

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
    case 'debug': return 'text-gray-400'
    case 'information': return 'text-blue-400'
    case 'warning': return 'text-yellow-400'
    case 'error': return 'text-red-400'
    case 'fatal': return 'text-red-500 font-bold'
    default: return 'text-gray-400'
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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Live Tail</h1>
        <div className="flex items-center gap-4">
          <span className={`flex items-center gap-2 ${isRunning ? 'text-green-400' : 'text-gray-400'}`}>
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`} />
            {isRunning ? 'Live' : 'Paused'}
          </span>
          <button
            onClick={() => setIsRunning(!isRunning)}
            className={`px-4 py-2 rounded ${
              isRunning
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-green-600 hover:bg-green-700'
            } text-white`}
          >
            {isRunning ? 'Pause' : 'Resume'}
          </button>
          <button
            onClick={() => {
              setLogs([])
              setLastTimestamp(null)
            }}
            className="px-4 py-2 rounded bg-gray-600 hover:bg-gray-700 text-white"
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <div className="bg-gray-900 rounded border border-gray-700 font-mono text-sm overflow-hidden">
        <div className="max-h-[70vh] overflow-y-auto">
          {logs.length === 0 ? (
            <div className="text-gray-500 text-center py-8">
              Waiting for logs...
            </div>
          ) : (
            <table className="w-full">
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} className="border-b border-gray-800 hover:bg-gray-800">
                    <td className="px-2 py-1 text-gray-500 whitespace-nowrap w-24">
                      {formatTimestamp(log.timestamp)}
                    </td>
                    <td className={`px-2 py-1 whitespace-nowrap w-20 ${getLevelClass(log.level)}`}>
                      {log.level.substring(0, 4).toUpperCase()}
                    </td>
                    <td className="px-2 py-1 text-gray-400 whitespace-nowrap w-32">
                      {log.source}
                    </td>
                    <td className="px-2 py-1 text-white">
                      {log.message}
                      {log.exception && (
                        <span className="text-red-400 ml-2">[Exception]</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
