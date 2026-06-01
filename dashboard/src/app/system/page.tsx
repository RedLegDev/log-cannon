'use client';

import { useState, useEffect } from 'react';
import {
  Database,
  HardDrive,
  FileText,
  Clock,
  Layers,
  AlertCircle,
  Loader2,
  RefreshCw,
  TrendingUp,
  Calendar,
  GitBranch,
  GitCommitHorizontal,
  Copy,
  Check
} from 'lucide-react';

interface PartitionInfo {
  partition: string;
  rows: number;
  size_bytes: number;
}

interface TableInfo {
  table: string;
  rows: number;
  size_bytes: number;
}

interface BuildInfo {
  commit: string;
  commitFull: string;
  commitDate: string | null;
  buildTime: string | null;
  branch: string;
  repoUrl: string | null;
  commitUrl: string | null;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

interface SystemMetrics {
  total_logs: number;
  total_logs_24h: number;
  oldest_log: string | null;
  newest_log: string | null;
  table_size_bytes: number;
  table_size_formatted: string;
  rows_per_partition: PartitionInfo[];
  disk_total_bytes: number;
  disk_free_bytes: number;
  disk_used_bytes: number;
  disk_used_percent: number;
  active_parts: number;
  tables: TableInfo[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

export default function SystemPage() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchMetrics = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/system');
      if (!res.ok) throw new Error('Failed to fetch system metrics');
      const data = await res.json();
      setMetrics(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch system metrics');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    fetch('/api/version')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setBuildInfo(data))
      .catch(() => setBuildInfo(null));
  }, []);

  const copyCommit = () => {
    if (!buildInfo || buildInfo.commitFull === 'dev') return;
    navigator.clipboard.writeText(buildInfo.commitFull).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Determine disk usage color
  const getDiskColor = (percent: number) => {
    if (percent >= 90) return 'cannon-critical';
    if (percent >= 70) return 'cannon-warning';
    return 'cannon-tracer';
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary font-mono">
            System <span className="text-cannon-fire">Status</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            Storage usage and capacity metrics
          </p>
        </div>
        <button
          onClick={() => fetchMetrics(true)}
          disabled={refreshing}
          className="btn-cannon-ghost flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Build Info */}
      {buildInfo && (
        <div className="card-cannon p-4 mb-6">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2 mb-4">
            <GitCommitHorizontal className="w-5 h-5 text-cannon-fire" />
            Build
          </h2>
          {buildInfo.commit === 'dev' ? (
            <p className="text-text-secondary text-sm">Development build (un-stamped)</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Commit */}
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cannon-steel">
                  <GitCommitHorizontal className="w-4 h-4 text-cannon-fire" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-text-muted">Commit</div>
                  <div className="flex items-center gap-2">
                    {buildInfo.commitUrl ? (
                      <a
                        href={buildInfo.commitUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={buildInfo.commitFull}
                        className="font-mono text-sm text-text-primary hover:text-cannon-fire transition-colors"
                      >
                        {buildInfo.commit}
                      </a>
                    ) : (
                      <span title={buildInfo.commitFull} className="font-mono text-sm text-text-primary">
                        {buildInfo.commit}
                      </span>
                    )}
                    <button
                      onClick={copyCommit}
                      title="Copy full SHA"
                      className="text-text-muted hover:text-cannon-fire transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
              {/* Branch */}
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cannon-steel">
                  <GitBranch className="w-4 h-4 text-text-muted" />
                </div>
                <div>
                  <div className="text-xs text-text-muted">Branch</div>
                  <div className="font-mono text-sm text-text-primary">{buildInfo.branch}</div>
                </div>
              </div>
              {/* Built */}
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cannon-steel">
                  <Clock className="w-4 h-4 text-cannon-tracer" />
                </div>
                <div>
                  <div className="text-xs text-text-muted">Built</div>
                  <div className="font-mono text-sm text-text-primary">{formatTimestamp(buildInfo.buildTime)}</div>
                  <div className="text-xs text-text-muted">commit {formatTimestamp(buildInfo.commitDate)}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cannon-critical flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="text-cannon-critical">{error}</span>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card-cannon p-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cannon-fire mx-auto mb-3" />
          <p className="text-text-secondary">Loading system metrics...</p>
        </div>
      ) : metrics ? (
        <>
          {/* Overview Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {/* Total Logs */}
            <div className="card-cannon p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-lg bg-cannon-fire/10">
                  <FileText className="w-5 h-5 text-cannon-fire" />
                </div>
                <span className="text-text-secondary text-sm">Total Logs</span>
              </div>
              <div className="text-2xl font-bold text-text-primary font-mono">
                {formatNumber(metrics.total_logs)}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {formatNumber(metrics.total_logs_24h)} in last 24h
              </div>
            </div>

            {/* Storage Size */}
            <div className="card-cannon p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-lg bg-cannon-tracer/10">
                  <Database className="w-5 h-5 text-cannon-tracer" />
                </div>
                <span className="text-text-secondary text-sm">Log Storage</span>
              </div>
              <div className="text-2xl font-bold text-text-primary font-mono">
                {metrics.table_size_formatted}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {metrics.active_parts} active parts
              </div>
            </div>

            {/* Disk Usage */}
            <div className="card-cannon p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className={`p-2 rounded-lg bg-${getDiskColor(metrics.disk_used_percent)}/10`}>
                  <HardDrive className={`w-5 h-5 text-${getDiskColor(metrics.disk_used_percent)}`} />
                </div>
                <span className="text-text-secondary text-sm">Disk Usage</span>
              </div>
              <div className="text-2xl font-bold text-text-primary font-mono">
                {metrics.disk_used_percent}%
              </div>
              <div className="text-xs text-text-muted mt-1">
                {formatBytes(metrics.disk_free_bytes)} free of {formatBytes(metrics.disk_total_bytes)}
              </div>
            </div>

            {/* Active Parts */}
            <div className="card-cannon p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-lg bg-cannon-ember/10">
                  <Layers className="w-5 h-5 text-cannon-ember" />
                </div>
                <span className="text-text-secondary text-sm">Partitions</span>
              </div>
              <div className="text-2xl font-bold text-text-primary font-mono">
                {metrics.rows_per_partition.length}
              </div>
              <div className="text-xs text-text-muted mt-1">
                Days with data
              </div>
            </div>
          </div>

          {/* Disk Usage Bar */}
          <div className="card-cannon p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-cannon-fire" />
                Disk Capacity
              </h2>
              <span className={`text-sm font-mono text-${getDiskColor(metrics.disk_used_percent)}`}>
                {metrics.disk_used_percent}% used
              </span>
            </div>
            <div className="w-full h-4 bg-cannon-graphite rounded-full overflow-hidden">
              <div
                className={`h-full bg-${getDiskColor(metrics.disk_used_percent)} transition-all duration-500`}
                style={{ width: `${Math.min(metrics.disk_used_percent, 100)}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs text-text-muted">
              <span>Used: {formatBytes(metrics.disk_used_bytes)}</span>
              <span>Free: {formatBytes(metrics.disk_free_bytes)}</span>
              <span>Total: {formatBytes(metrics.disk_total_bytes)}</span>
            </div>
          </div>

          {/* Two Column Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Time Range */}
            <div className="card-cannon p-4">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2 mb-4">
                <Clock className="w-5 h-5 text-cannon-fire" />
                Data Time Range
              </h2>
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-cannon-steel">
                    <Calendar className="w-4 h-4 text-text-muted" />
                  </div>
                  <div>
                    <div className="text-xs text-text-muted">Oldest Log</div>
                    <div className="font-mono text-sm text-text-primary">
                      {metrics.oldest_log || 'No data'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-cannon-steel">
                    <TrendingUp className="w-4 h-4 text-cannon-tracer" />
                  </div>
                  <div>
                    <div className="text-xs text-text-muted">Newest Log</div>
                    <div className="font-mono text-sm text-text-primary">
                      {metrics.newest_log || 'No data'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Tables */}
            <div className="card-cannon p-4">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2 mb-4">
                <Database className="w-5 h-5 text-cannon-fire" />
                Tables
              </h2>
              {metrics.tables.length === 0 ? (
                <p className="text-text-secondary text-sm">No tables found</p>
              ) : (
                <div className="space-y-2">
                  {metrics.tables.map((table) => (
                    <div
                      key={table.table}
                      className="flex items-center justify-between p-3 bg-cannon-steel rounded-lg"
                    >
                      <div>
                        <div className="font-mono text-sm text-text-primary">{table.table}</div>
                        <div className="text-xs text-text-muted">
                          {formatNumber(table.rows)} rows
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm text-cannon-fire">
                          {formatBytes(table.size_bytes)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Partitions Table */}
          {metrics.rows_per_partition.length > 0 && (
            <div className="card-cannon overflow-hidden mt-6">
              <div className="px-4 py-3 bg-cannon-steel border-b border-cannon-graphite">
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Layers className="w-5 h-5 text-cannon-fire" />
                  Partitions by Date
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-cannon-steel/50">
                    <tr className="text-left text-text-secondary text-sm">
                      <th className="px-4 py-3 font-medium">Partition (Date)</th>
                      <th className="px-4 py-3 text-right font-medium">Rows</th>
                      <th className="px-4 py-3 text-right font-medium">Size</th>
                      <th className="px-4 py-3 font-medium">Distribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.rows_per_partition.map((partition) => {
                      const maxRows = Math.max(...metrics.rows_per_partition.map(p => p.rows));
                      const widthPercent = maxRows > 0 ? (partition.rows / maxRows) * 100 : 0;
                      return (
                        <tr
                          key={partition.partition}
                          className="border-t border-cannon-graphite hover:bg-cannon-steel/50 transition-colors"
                        >
                          <td className="px-4 py-3 font-mono text-text-primary">
                            {partition.partition}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-text-code tabular-nums">
                            {formatNumber(partition.rows)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-cannon-fire tabular-nums">
                            {formatBytes(partition.size_bytes)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="w-full h-2 bg-cannon-graphite rounded-full overflow-hidden">
                              <div
                                className="h-full bg-cannon-fire rounded-full transition-all"
                                style={{ width: `${widthPercent}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
