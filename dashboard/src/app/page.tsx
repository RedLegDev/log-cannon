import { auth } from '@clerk/nextjs/server'
import Link from 'next/link'
import {
  getCurrentMetrics,
  getHourOverHourTrend,
  getTimeSeries,
  getErrorRateTimeSeries,
  getTopServicesByErrors,
  getSavedQueries,
  getDashboards,
  getAlertsWithStatus,
  SavedQuery,
  AlertWithStatus
} from '@/lib/clickhouse'
import { AuthGate } from '@/components/AuthGate'
import { MetricCard } from '@/components/MetricCard'
import { AlertStatusCard } from '@/components/AlertStatusCard'
import {
  Activity,
  FileText,
  Server,
  Percent,
  Search,
  LayoutDashboard,
  ChevronRight,
  AlertCircle,
  Bell
} from 'lucide-react'

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K'
  }
  return num.toLocaleString()
}

function buildQueryUrl(query: SavedQuery): string {
  const params = new URLSearchParams()
  if (query.source) params.set('source', query.source)
  if (query.level) params.set('level', query.level)
  if (query.search) params.set('search', query.search)

  try {
    const filters = JSON.parse(query.property_filters)
    for (const filter of filters) {
      const key = `prop.${filter.key}`
      const value = filter.operator && filter.operator !== '='
        ? `${filter.operator}${filter.value}`
        : filter.value
      params.set(key, value)
    }
  } catch {
    // Ignore parse errors
  }

  const queryString = params.toString()
  return queryString ? `/logs?${queryString}` : '/logs'
}

export default async function HomePage() {
  const { userId } = await auth()

  let error: string | null = null
  let metrics = {
    logs_per_minute: 0,
    total_logs_24h: 0,
    total_errors_24h: 0,
    error_rate_24h: 0,
    active_services: 0,
    services_with_errors: 0
  }
  let trend = { current_hour_count: 0, previous_hour_count: 0, trend_percent: 0 }
  let timeSeries: { minute: string; count: number; errors: number }[] = []
  let errorRateSeries: { minute: string; error_rate: number }[] = []
  let topServices: Awaited<ReturnType<typeof getTopServicesByErrors>> = []
  let savedQueries: SavedQuery[] = []
  let dashboards: Awaited<ReturnType<typeof getDashboards>> = []
  let alertsWithStatus: AlertWithStatus[] = []

  if (userId) {
    try {
      const [
        metricsData,
        trendData,
        timeSeriesData,
        errorRateData,
        servicesData,
        queriesData,
        dashboardsData,
        alertsStatusData
      ] = await Promise.all([
        getCurrentMetrics(),
        getHourOverHourTrend(),
        getTimeSeries(60),
        getErrorRateTimeSeries(60),
        getTopServicesByErrors(5),
        getSavedQueries(),
        getDashboards(),
        getAlertsWithStatus()
      ])

      metrics = metricsData
      trend = trendData
      timeSeries = timeSeriesData
      errorRateSeries = errorRateData
      topServices = servicesData
      savedQueries = queriesData.slice(0, 4)
      dashboards = dashboardsData.filter(d => d.enabled).slice(0, 4)
      alertsWithStatus = alertsStatusData
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load dashboard data'
    }
  }

  // Prepare sparkline data
  const logsSparkline = timeSeries.map(p => Number(p.count))
  const errorRateSparkline = errorRateSeries.map(p => Number(p.error_rate))

  // Determine error rate color
  const errorRateColor = metrics.error_rate_24h > 5 ? 'critical' : metrics.error_rate_24h > 1 ? 'warning' : 'success'

  return (
    <AuthGate hasServerData={!!userId}>
      <div className="animate-fade-in">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary font-mono">
            <span className="text-cannon-fire">Dashboard</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            System overview and quick access
          </p>
        </div>

        {error ? (
          <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-cannon-critical flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-medium text-cannon-critical">Error loading dashboard</h3>
                <p className="text-text-secondary text-sm mt-1">{error}</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Metrics Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <MetricCard
                icon={Activity}
                label="Logs per minute"
                value={formatNumber(metrics.logs_per_minute)}
                trend={{ value: trend.trend_percent, label: 'vs last hour' }}
                sparkline={logsSparkline}
                color="fire"
              />

              <MetricCard
                icon={FileText}
                label="Logs today (24h)"
                value={formatNumber(metrics.total_logs_24h)}
                secondaryText={`${formatNumber(metrics.total_errors_24h)} errors (${metrics.error_rate_24h}%)`}
                color="fire"
              />

              <MetricCard
                icon={Server}
                label="Active services"
                value={metrics.active_services}
                secondaryText={metrics.services_with_errors > 0 ? `${metrics.services_with_errors} with errors` : undefined}
                secondaryLink={metrics.services_with_errors > 0 ? '#services' : undefined}
                color="tracer"
              />

              <MetricCard
                icon={Percent}
                label="Error rate (24h)"
                value={`${metrics.error_rate_24h}%`}
                sparkline={errorRateSparkline}
                color={errorRateColor}
              />
            </div>

            {/* Alert Status Cards */}
            {alertsWithStatus.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                    <Bell className="w-5 h-5 text-cannon-fire" />
                    Alert Status
                  </h2>
                  <Link
                    href="/alerts"
                    className="text-sm text-text-secondary hover:text-cannon-fire transition-colors flex items-center gap-1"
                  >
                    Manage alerts <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {alertsWithStatus.map(alert => (
                    <AlertStatusCard
                      key={alert.id}
                      id={alert.id}
                      name={alert.name}
                      description={alert.description}
                      status={alert.status}
                      minutesAgo={alert.minutes_ago}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Two Column Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Services Section - takes 2 columns */}
              <div className="lg:col-span-2" id="services">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                    <Server className="w-5 h-5 text-cannon-fire" />
                    Top Services by Errors
                  </h2>
                  <Link
                    href="/services"
                    className="text-sm text-text-secondary hover:text-cannon-fire transition-colors flex items-center gap-1"
                  >
                    View all <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>

                {topServices.length === 0 ? (
                  <div className="card-cannon p-8 text-center">
                    <div className="w-16 h-16 rounded-full bg-cannon-steel flex items-center justify-center mx-auto mb-4">
                      <Server className="w-8 h-8 text-text-muted" />
                    </div>
                    <h3 className="text-lg font-medium text-text-primary mb-2">No services found</h3>
                    <p className="text-text-secondary text-sm">
                      Start sending logs to see service stats here.
                    </p>
                  </div>
                ) : (
                  <div className="card-cannon overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-cannon-steel">
                          <tr className="text-left text-text-secondary text-sm">
                            <th className="px-4 py-3 font-medium">Service</th>
                            <th className="px-4 py-3 text-right font-medium">Logs (24h)</th>
                            <th className="px-4 py-3 text-right font-medium">Errors</th>
                            <th className="px-4 py-3 text-right font-medium">Error Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {topServices.map(s => (
                            <tr key={s.source} className="border-t border-cannon-graphite hover:bg-cannon-steel/50 transition-colors">
                              <td className="px-4 py-3">
                                <Link
                                  href={`/logs?source=${encodeURIComponent(s.source)}`}
                                  className="text-text-primary font-medium font-mono hover:text-cannon-fire transition-colors"
                                >
                                  {s.source}
                                </Link>
                              </td>
                              <td className="px-4 py-3 text-right text-text-code font-mono tabular-nums">
                                {Number(s.total_count).toLocaleString()}
                              </td>
                              <td className="px-4 py-3 text-right text-cannon-critical font-mono tabular-nums">
                                {Number(s.error_count).toLocaleString()}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-16 h-2 bg-cannon-graphite rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full transition-all ${Number(s.error_rate) > 5 ? 'bg-cannon-critical' : 'bg-cannon-tracer'}`}
                                      style={{ width: `${Math.min(Number(s.error_rate), 100)}%` }}
                                    />
                                  </div>
                                  <span className={`font-mono tabular-nums text-sm ${Number(s.error_rate) > 5 ? 'text-cannon-critical' : 'text-text-code'}`}>
                                    {s.error_rate}%
                                  </span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Quick Access Section - takes 1 column */}
              <div className="space-y-6">
                {/* Saved Queries */}
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                      <Search className="w-5 h-5 text-cannon-fire" />
                      Saved Queries
                    </h2>
                    <Link
                      href="/queries"
                      className="text-sm text-text-secondary hover:text-cannon-fire transition-colors flex items-center gap-1"
                    >
                      View all <ChevronRight className="w-4 h-4" />
                    </Link>
                  </div>

                  <div className="card-cannon divide-y divide-cannon-graphite">
                    {savedQueries.length === 0 ? (
                      <div className="p-4 text-center text-text-secondary text-sm">
                        No saved queries yet
                      </div>
                    ) : (
                      savedQueries.map(query => (
                        <Link
                          key={query.id}
                          href={buildQueryUrl(query)}
                          className="block px-4 py-3 hover:bg-cannon-steel/50 transition-colors"
                        >
                          <div className="text-text-primary font-medium text-sm truncate">
                            {query.name}
                          </div>
                          {query.description && (
                            <div className="text-text-muted text-xs truncate mt-0.5">
                              {query.description}
                            </div>
                          )}
                        </Link>
                      ))
                    )}
                  </div>
                </div>

                {/* Dashboards */}
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                      <LayoutDashboard className="w-5 h-5 text-cannon-fire" />
                      Dashboards
                    </h2>
                    <Link
                      href="/dashboards"
                      className="text-sm text-text-secondary hover:text-cannon-fire transition-colors flex items-center gap-1"
                    >
                      View all <ChevronRight className="w-4 h-4" />
                    </Link>
                  </div>

                  <div className="card-cannon divide-y divide-cannon-graphite">
                    {dashboards.length === 0 ? (
                      <div className="p-4 text-center text-text-secondary text-sm">
                        No dashboards yet
                      </div>
                    ) : (
                      dashboards.map(dashboard => (
                        <Link
                          key={dashboard.id}
                          href={`/dashboards/${dashboard.name}`}
                          className="block px-4 py-3 hover:bg-cannon-steel/50 transition-colors"
                        >
                          <div className="text-text-primary font-medium text-sm truncate">
                            {dashboard.name}
                          </div>
                          {dashboard.description && (
                            <div className="text-text-muted text-xs truncate mt-0.5">
                              {dashboard.description}
                            </div>
                          )}
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </AuthGate>
  )
}
