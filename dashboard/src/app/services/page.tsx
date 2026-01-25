import { getServiceStats, getTimeSeries } from '@/lib/clickhouse'

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

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Service Overview</h1>

      {error ? (
        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded">
          {error}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div className="bg-gray-800 rounded p-6 border border-gray-700">
              <div className="text-gray-400 text-sm">Total Logs (24h)</div>
              <div className="text-3xl font-bold text-white">{totalLogs.toLocaleString()}</div>
            </div>
            <div className="bg-gray-800 rounded p-6 border border-gray-700">
              <div className="text-gray-400 text-sm">Total Errors (24h)</div>
              <div className="text-3xl font-bold text-red-400">{totalErrors.toLocaleString()}</div>
            </div>
            <div className="bg-gray-800 rounded p-6 border border-gray-700">
              <div className="text-gray-400 text-sm">Active Services</div>
              <div className="text-3xl font-bold text-blue-400">{stats.length}</div>
            </div>
          </div>

          <h2 className="text-xl font-semibold text-white mb-4">Services</h2>

          {stats.length === 0 ? (
            <div className="text-gray-400 text-center py-8">
              No services found. Start sending logs to see stats here.
            </div>
          ) : (
            <div className="bg-gray-800 rounded border border-gray-700 overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-750">
                  <tr className="text-left text-gray-400 text-sm">
                    <th className="px-4 py-3">Service</th>
                    <th className="px-4 py-3 text-right">Total Logs</th>
                    <th className="px-4 py-3 text-right">Errors</th>
                    <th className="px-4 py-3 text-right">Error Rate</th>
                    <th className="px-4 py-3 text-right">Last Log</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map(s => {
                    const errorRate = Number(s.total_count) > 0
                      ? (Number(s.error_count) / Number(s.total_count) * 100).toFixed(1)
                      : '0.0'
                    return (
                      <tr key={s.source} className="border-t border-gray-700 hover:bg-gray-750">
                        <td className="px-4 py-3 text-white font-medium">{s.source}</td>
                        <td className="px-4 py-3 text-right text-gray-300">{Number(s.total_count).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right text-red-400">{Number(s.error_count).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right">
                          <span className={Number(errorRate) > 5 ? 'text-red-400' : 'text-gray-300'}>
                            {errorRate}%
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-400 text-sm">
                          {formatTimestamp(s.last_log)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="text-xl font-semibold text-white mt-8 mb-4">Log Volume (Last Hour)</h2>

          {timeSeries.length === 0 ? (
            <div className="text-gray-400 text-center py-8 bg-gray-800 rounded border border-gray-700">
              No data available for the last hour.
            </div>
          ) : (
            <div className="bg-gray-800 rounded p-4 border border-gray-700">
              <div className="h-48 flex items-end gap-1">
                {timeSeries.map((point, i) => {
                  const maxCount = Math.max(...timeSeries.map(p => Number(p.count)))
                  const height = maxCount > 0 ? (Number(point.count) / maxCount * 100) : 0
                  const errorHeight = Number(point.count) > 0
                    ? (Number(point.errors) / Number(point.count) * height)
                    : 0
                  return (
                    <div
                      key={i}
                      className="flex-1 flex flex-col justify-end"
                      title={`${point.minute}: ${point.count} logs, ${point.errors} errors`}
                    >
                      <div
                        className="bg-blue-500 w-full rounded-t relative"
                        style={{ height: `${height}%`, minHeight: Number(point.count) > 0 ? '2px' : '0' }}
                      >
                        {Number(point.errors) > 0 && (
                          <div
                            className="bg-red-500 w-full absolute bottom-0 rounded-t"
                            style={{ height: `${errorHeight}%`, minHeight: '2px' }}
                          />
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-2">
                <span>1 hour ago</span>
                <span>Now</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
