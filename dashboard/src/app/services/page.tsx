import { getServiceStats, getTimeSeries } from '@/lib/clickhouse'
import { FileText, AlertTriangle, Server, Clock, AlertCircle } from 'lucide-react'

function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts)
    return date.toLocaleString()
  } catch {
    return ts
  }
}

export default async function ServicesPage() {
  let stats: Awaited<ReturnType<typeof getServiceStats>> = []
  let timeSeries: Awaited<ReturnType<typeof getTimeSeries>> = []
  let error: string | null = null

  try {
    [stats, timeSeries] = await Promise.all([
      getServiceStats(),
      getTimeSeries(60)
    ])
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch stats'
  }

  const totalLogs = stats.reduce((sum, s) => sum + Number(s.total_count), 0)
  const totalErrors = stats.reduce((sum, s) => sum + Number(s.error_count), 0)
  const errorRate = totalLogs > 0 ? ((totalErrors / totalLogs) * 100).toFixed(2) : '0.00'

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary font-mono">
          Service <span className="text-cannon-fire">Overview</span>
        </h1>
        <p className="text-text-secondary text-sm mt-1">
          Monitor service health and log volume
        </p>
      </div>

      {error ? (
        <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cannon-critical flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-cannon-critical">Error loading stats</h3>
              <p className="text-text-secondary text-sm mt-1">{error}</p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <div className="card-cannon p-5 group hover:border-cannon-fire/50 transition-all">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-cannon-steel flex items-center justify-center group-hover:bg-cannon-fire/20 transition-colors">
                  <FileText className="w-5 h-5 text-cannon-fire" />
                </div>
                <span className="text-text-secondary text-sm">Total Logs (24h)</span>
              </div>
              <div className="text-3xl font-bold text-text-primary font-mono tabular-nums">
                {totalLogs.toLocaleString()}
              </div>
            </div>

            <div className="card-cannon p-5 group hover:border-cannon-critical/50 transition-all">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-cannon-steel flex items-center justify-center group-hover:bg-cannon-critical/20 transition-colors">
                  <AlertTriangle className="w-5 h-5 text-cannon-critical" />
                </div>
                <span className="text-text-secondary text-sm">Total Errors (24h)</span>
              </div>
              <div className="text-3xl font-bold text-cannon-critical font-mono tabular-nums">
                {totalErrors.toLocaleString()}
              </div>
            </div>

            <div className="card-cannon p-5 group hover:border-cannon-warning/50 transition-all">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-cannon-steel flex items-center justify-center group-hover:bg-cannon-warning/20 transition-colors">
                  <AlertCircle className="w-5 h-5 text-cannon-warning" />
                </div>
                <span className="text-text-secondary text-sm">Error Rate</span>
              </div>
              <div className={`text-3xl font-bold font-mono tabular-nums ${Number(errorRate) > 5 ? 'text-cannon-critical' : 'text-cannon-warning'}`}>
                {errorRate}%
              </div>
            </div>

            <div className="card-cannon p-5 group hover:border-cannon-tracer/50 transition-all">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-cannon-steel flex items-center justify-center group-hover:bg-cannon-tracer/20 transition-colors">
                  <Server className="w-5 h-5 text-cannon-tracer" />
                </div>
                <span className="text-text-secondary text-sm">Active Services</span>
              </div>
              <div className="text-3xl font-bold text-cannon-tracer font-mono tabular-nums">
                {stats.length}
              </div>
            </div>
          </div>

          {/* Services Table */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <Server className="w-5 h-5 text-cannon-fire" />
              Services
            </h2>

            {stats.length === 0 ? (
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
                        <th className="px-4 py-3 text-right font-medium">Total Logs</th>
                        <th className="px-4 py-3 text-right font-medium">Errors</th>
                        <th className="px-4 py-3 text-right font-medium">Error Rate</th>
                        <th className="px-4 py-3 text-right font-medium">Last Log</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map(s => {
                        const serviceErrorRate = Number(s.total_count) > 0
                          ? (Number(s.error_count) / Number(s.total_count) * 100).toFixed(1)
                          : '0.0'
                        return (
                          <tr key={s.source} className="border-t border-cannon-graphite hover:bg-cannon-steel/50 transition-colors">
                            <td className="px-4 py-3">
                              <span className="text-text-primary font-medium font-mono">{s.source}</span>
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
                                    className={`h-full rounded-full transition-all ${Number(serviceErrorRate) > 5 ? 'bg-cannon-critical' : 'bg-cannon-tracer'}`}
                                    style={{ width: `${Math.min(Number(serviceErrorRate), 100)}%` }}
                                  />
                                </div>
                                <span className={`font-mono tabular-nums text-sm ${Number(serviceErrorRate) > 5 ? 'text-cannon-critical' : 'text-text-code'}`}>
                                  {serviceErrorRate}%
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-text-muted text-sm font-mono">
                              {formatTimestamp(s.last_log)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Time Series Chart */}
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <Clock className="w-5 h-5 text-cannon-fire" />
              Log Volume (Last Hour)
            </h2>

            {timeSeries.length === 0 ? (
              <div className="card-cannon p-8 text-center">
                <p className="text-text-secondary">No data available for the last hour.</p>
              </div>
            ) : (
              <div className="card-cannon p-4">
                <div className="h-48 flex items-end gap-0.5">
                  {timeSeries.map((point, i) => {
                    const maxCount = Math.max(...timeSeries.map(p => Number(p.count)))
                    const height = maxCount > 0 ? (Number(point.count) / maxCount * 100) : 0
                    const errorHeight = Number(point.count) > 0
                      ? (Number(point.errors) / Number(point.count) * height)
                      : 0
                    return (
                      <div
                        key={i}
                        className="flex-1 h-full flex flex-col justify-end group cursor-pointer"
                        title={`${point.minute}: ${point.count} logs, ${point.errors} errors`}
                      >
                        <div
                          className="bg-cannon-fire/80 group-hover:bg-cannon-fire w-full rounded-t relative transition-colors"
                          style={{ height: `${height}%`, minHeight: Number(point.count) > 0 ? '2px' : '0' }}
                        >
                          {Number(point.errors) > 0 && (
                            <div
                              className="bg-cannon-critical w-full absolute bottom-0 rounded-t"
                              style={{ height: `${errorHeight}%`, minHeight: '2px' }}
                            />
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between text-xs text-text-muted mt-3 font-mono">
                  <span>1 hour ago</span>
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 bg-cannon-fire rounded-sm"></span>
                      Logs
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 bg-cannon-critical rounded-sm"></span>
                      Errors
                    </span>
                  </div>
                  <span>Now</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
