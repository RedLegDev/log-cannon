import { getRecentLogs, getSources, LogEvent } from '@/lib/clickhouse'

interface SearchParams {
  source?: string
  level?: string
  search?: string
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

function formatProperties(props: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(props)
    if (Object.keys(parsed).length === 0) return null
    return parsed
  } catch {
    return null
  }
}

export default async function LogExplorer({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  let logs: LogEvent[] = []
  let sources: string[] = []
  let error: string | null = null

  try {
    [logs, sources] = await Promise.all([
      getRecentLogs(searchParams.source, searchParams.level, searchParams.search),
      getSources()
    ])
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch logs'
  }

  const levels = ['Debug', 'Information', 'Warning', 'Error', 'Fatal']

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Log Explorer</h1>

      <form className="mb-6 flex gap-4 flex-wrap">
        <select
          name="source"
          defaultValue={searchParams.source || ''}
          className="bg-gray-800 border border-gray-600 text-white rounded px-3 py-2"
        >
          <option value="">All Sources</option>
          {sources.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          name="level"
          defaultValue={searchParams.level || ''}
          className="bg-gray-800 border border-gray-600 text-white rounded px-3 py-2"
        >
          <option value="">All Levels</option>
          {levels.map(l => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>

        <input
          type="text"
          name="search"
          placeholder="Search messages..."
          defaultValue={searchParams.search || ''}
          className="bg-gray-800 border border-gray-600 text-white rounded px-3 py-2 flex-grow"
        />

        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
        >
          Search
        </button>
      </form>

      {error ? (
        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded">
          {error}
        </div>
      ) : logs.length === 0 ? (
        <div className="text-gray-400 text-center py-8">
          No logs found. Logs from the last 24 hours will appear here.
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map(log => {
            const props = formatProperties(log.properties)
            return (
              <div key={log.id} className="bg-gray-800 rounded p-4 border border-gray-700">
                <div className="flex items-start justify-between">
                  <div className="flex-grow">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-gray-500 text-sm">{formatTimestamp(log.timestamp)}</span>
                      <span className={`font-medium ${getLevelClass(log.level)}`}>{log.level}</span>
                      <span className="text-gray-400 text-sm">{log.source}</span>
                    </div>
                    <div className="text-white font-mono text-sm">{log.message}</div>
                    {log.exception && (
                      <pre className="mt-2 text-red-400 text-xs bg-gray-900 p-2 rounded overflow-x-auto">
                        {log.exception}
                      </pre>
                    )}
                    {props && (
                      <details className="mt-2">
                        <summary className="text-gray-500 text-sm cursor-pointer hover:text-gray-300">
                          Properties
                        </summary>
                        <pre className="mt-1 text-gray-400 text-xs bg-gray-900 p-2 rounded overflow-x-auto">
                          {JSON.stringify(props, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
