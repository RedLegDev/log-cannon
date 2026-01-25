import { Suspense } from 'react'
import { getRecentLogs, getSources, LogEvent, PropertyFilter } from '@/lib/clickhouse'
import { LogList } from '@/components/LogList'
import { FilterBar } from '@/components/FilterBar'

interface SearchParams {
  source?: string
  level?: string
  search?: string
  [key: string]: string | undefined
}

function parsePropertyFilters(searchParams: SearchParams): PropertyFilter[] {
  const filters: PropertyFilter[] = []

  for (const [key, value] of Object.entries(searchParams)) {
    if (key.startsWith('prop.') && value) {
      const exclude = key.endsWith('!')
      const propKey = exclude
        ? key.slice(5, -1)  // Remove 'prop.' and '!'
        : key.slice(5)      // Remove 'prop.'

      filters.push({ key: propKey, value, exclude })
    }
  }

  return filters
}

export default async function LogExplorer({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  let logs: LogEvent[] = []
  let sources: string[] = []
  let error: string | null = null

  const propertyFilters = parsePropertyFilters(searchParams)

  try {
    [logs, sources] = await Promise.all([
      getRecentLogs(
        searchParams.source,
        searchParams.level,
        searchParams.search,
        propertyFilters
      ),
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

      <Suspense fallback={null}>
        <FilterBar />
      </Suspense>

      {error ? (
        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded">
          {error}
        </div>
      ) : logs.length === 0 ? (
        <div className="text-gray-400 text-center py-8">
          No logs found. Logs from the last 24 hours will appear here.
        </div>
      ) : (
        <LogList logs={logs} />
      )}
    </div>
  )
}
