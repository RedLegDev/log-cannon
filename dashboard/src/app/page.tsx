import { Suspense } from 'react'
import { getRecentLogs, getSources, LogEvent, PropertyFilter, parseOperatorFromValue } from '@/lib/clickhouse'
import { LogList } from '@/components/LogList'
import { FilterBar } from '@/components/FilterBar'
import { SaveQueryButton } from '@/components/SaveQueryButton'
import { Search, ChevronDown, AlertCircle } from 'lucide-react'

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
      // Handle legacy exclude format: prop.key!
      const isLegacyExclude = key.endsWith('!')
      const propKey = isLegacyExclude
        ? key.slice(5, -1)  // Remove 'prop.' and '!'
        : key.slice(5)      // Remove 'prop.'

      if (isLegacyExclude) {
        // Legacy format: prop.key! with value
        filters.push({ key: propKey, value, operator: '!=' })
      } else {
        // New format: parse operator from value (e.g., ">5", ">=10", "!=foo")
        const { operator, value: parsedValue } = parseOperatorFromValue(value)
        filters.push({ key: propKey, value: parsedValue, operator })
      }
    }
  }

  return filters
}

export default async function LogExplorer({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  let logs: LogEvent[] = []
  let sources: string[] = []
  let error: string | null = null

  const resolvedParams = await searchParams
  const propertyFilters = parsePropertyFilters(resolvedParams)

  try {
    [logs, sources] = await Promise.all([
      getRecentLogs(
        resolvedParams.source,
        resolvedParams.level,
        resolvedParams.search,
        propertyFilters
      ),
      getSources()
    ])
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch logs'
  }

  const levels = ['Debug', 'Information', 'Warning', 'Error', 'Fatal']

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary font-mono">
          Log <span className="text-cannon-fire">Explorer</span>
        </h1>
        <p className="text-text-secondary text-sm mt-1">
          Search and filter logs from the last 24 hours
        </p>
      </div>

      {/* Search Form */}
      <form className="mb-6" key={`${resolvedParams.source || ''}-${resolvedParams.level || ''}-${resolvedParams.search || ''}`}>
        {/* Preserve property filters as hidden inputs */}
        {Object.entries(resolvedParams)
          .filter(([key]) => key.startsWith('prop.'))
          .map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value || ''} />
          ))
        }
        <div className="card-cannon p-4">
          <div className="flex flex-col md:flex-row gap-3">
            {/* Source Select */}
            <div className="relative md:w-48">
              <select
                name="source"
                defaultValue={resolvedParams.source || ''}
                className="select-cannon w-full appearance-none pr-10"
              >
                <option value="">All Sources</option>
                {sources.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
            </div>

            {/* Level Select */}
            <div className="relative md:w-44">
              <select
                name="level"
                defaultValue={resolvedParams.level || ''}
                className="select-cannon w-full appearance-none pr-10"
              >
                <option value="">All Levels</option>
                {levels.map(l => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
            </div>

            {/* Search Input */}
            <div className="relative flex-grow">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
              <input
                type="text"
                name="search"
                placeholder="Search messages..."
                defaultValue={resolvedParams.search || ''}
                className="input-cannon pl-10 w-full"
              />
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              className="btn-cannon whitespace-nowrap"
            >
              <Search className="w-4 h-4 md:hidden" />
              <span className="hidden md:inline">Search Logs</span>
            </button>

            {/* Save Query Button */}
            <Suspense fallback={null}>
              <SaveQueryButton />
            </Suspense>
          </div>
        </div>
      </form>

      {/* Active Filters */}
      <Suspense fallback={null}>
        <FilterBar />
      </Suspense>

      {/* Results */}
      {error ? (
        <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cannon-critical flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-cannon-critical">Error loading logs</h3>
              <p className="text-text-secondary text-sm mt-1">{error}</p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Results count */}
          {logs.length > 0 && (
            <div className="mb-4 text-text-secondary text-sm">
              Showing <span className="text-text-primary font-medium">{logs.length}</span> logs
            </div>
          )}
          <LogList logs={logs} />
        </>
      )}
    </div>
  )
}
