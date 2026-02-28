import { Suspense } from 'react'
import { auth } from '@clerk/nextjs/server'
import { getRecentLogs, getLogById, getSources, LogEvent, PropertyFilter, parseOperatorFromValue, TimeFilter } from '@/lib/clickhouse'
import { LogExplorer } from '@/components/LogExplorer'
import { FilterBar } from '@/components/FilterBar'
import { SaveQueryButton } from '@/components/SaveQueryButton'
import { DeleteLogsButton } from '@/components/DeleteLogsButton'
import { AuthGate } from '@/components/AuthGate'
import { TimeRangeFilter } from '@/components/TimeRangeFilter'
import { parseTimeRangeFromParams, resolveTimeRange, formatTimeRangeDisplay } from '@/lib/timeRange'
import { Search, ChevronDown, AlertCircle } from 'lucide-react'

interface SearchParams {
  source?: string
  level?: string
  search?: string
  time?: string
  from?: string
  to?: string
  id?: string
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

export default async function LogExplorerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  // Try to get auth state - if authenticated, fetch logs server-side for performance
  // If not authenticated (e.g., cross-app deep link), AuthGate will handle it client-side
  const { userId } = await auth()

  let logs: LogEvent[] = []
  let sources: string[] = []
  let error: string | null = null

  const resolvedParams = await searchParams
  const propertyFilters = parsePropertyFilters(resolvedParams)

  // Parse time range from URL params
  const urlParams = new URLSearchParams()
  if (resolvedParams.time) urlParams.set('time', resolvedParams.time)
  if (resolvedParams.from) urlParams.set('from', resolvedParams.from)
  if (resolvedParams.to) urlParams.set('to', resolvedParams.to)
  const timeRange = parseTimeRangeFromParams(urlParams)
  const timeBounds = resolveTimeRange(timeRange)
  const timeFilter: TimeFilter = {
    start: timeBounds.start,
    end: timeBounds.end,
  }

  // Only fetch data if we have a userId (server-side auth succeeded)
  if (userId) {
    try {
      [logs, sources] = await Promise.all([
        getRecentLogs(
          resolvedParams.source,
          resolvedParams.level,
          resolvedParams.search,
          propertyFilters,
          timeFilter
        ),
        getSources(timeFilter)
      ])

      // If a specific log ID is requested, ensure it's included in the results
      if (resolvedParams.id) {
        const logExists = logs.some(log => log.id === resolvedParams.id)
        if (!logExists) {
          const specificLog = await getLogById(resolvedParams.id)
          if (specificLog) {
            // Prepend the specific log so it's visible at the top
            logs = [specificLog, ...logs]
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to fetch logs'
    }
  }

  const timeDescription = formatTimeRangeDisplay(timeRange)

  const levels = ['Debug', 'Information', 'Warning', 'Error', 'Fatal']

  return (
    <AuthGate hasServerData={!!userId}>
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary font-mono">
          Log <span className="text-cannon-fire">Explorer</span>
        </h1>
        <p className="text-text-secondary text-sm mt-1">
          Search and filter logs &middot; {timeDescription}
        </p>
      </div>

      {/* Search Form */}
      <form className="mb-6" key={`${resolvedParams.source || ''}-${resolvedParams.level || ''}-${resolvedParams.search || ''}`}>
        {/* Preserve time range and property filters as hidden inputs */}
        {Object.entries(resolvedParams)
          .filter(([key]) => key.startsWith('prop.') || key === 'time' || key === 'from' || key === 'to')
          .map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value || ''} />
          ))
        }
        <div className="card-cannon p-4">
          <div className="flex flex-col md:flex-row gap-3">
            {/* Time Range Filter */}
            <Suspense fallback={null}>
              <TimeRangeFilter />
            </Suspense>

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

            {/* Delete Logs Button */}
            <Suspense fallback={null}>
              <DeleteLogsButton />
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
        <LogExplorer initialLogs={logs} highlightedLogId={resolvedParams.id} />
      )}
    </div>
    </AuthGate>
  )
}
