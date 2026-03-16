'use client';

import { useState, useEffect } from 'react';
import {
  Archive,
  AlertCircle,
  Loader2,
  RefreshCw,
  Clock,
  HardDrive,
  CheckCircle2,
  Database,
  Layers,
} from 'lucide-react';

interface Backup {
  name: string;
  timestamp: string;
  size: number;
  size_formatted: string;
  type: 'full' | 'incremental' | 'legacy';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TypeBadge({ type }: { type: Backup['type'] }) {
  if (type === 'full') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-cannon-fire bg-cannon-fire/10 px-2 py-0.5 rounded-full">
        <Database className="w-3 h-3" />
        Full
      </span>
    );
  }
  if (type === 'incremental') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-cannon-tracer bg-cannon-tracer/10 px-2 py-0.5 rounded-full">
        <Layers className="w-3 h-3" />
        Incremental
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted bg-cannon-steel px-2 py-0.5 rounded-full">
      <Database className="w-3 h-3" />
      Legacy
    </span>
  );
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBackups = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/v1/backups');
      if (!res.ok) throw new Error('Failed to fetch backups');
      const data = await res.json();
      setBackups(data.backups);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch backups');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchBackups();
  }, []);

  const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
  const fullCount = backups.filter((b) => b.type === 'full' || b.type === 'legacy').length;
  const incrCount = backups.filter((b) => b.type === 'incremental').length;

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary font-mono">
            <span className="text-cannon-fire">Backups</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            ClickHouse database backups synced to Cloudflare R2
          </p>
        </div>
        <button
          onClick={() => fetchBackups(true)}
          disabled={refreshing}
          className="btn-cannon-ghost flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

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

      {/* Summary Cards */}
      {!loading && backups.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
          <div className="card-cannon p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 rounded-lg bg-cannon-fire/10">
                <Archive className="w-5 h-5 text-cannon-fire" />
              </div>
              <span className="text-text-secondary text-sm">Total Backups</span>
            </div>
            <div className="text-2xl font-bold text-text-primary font-mono">
              {backups.length}
            </div>
          </div>
          <div className="card-cannon p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 rounded-lg bg-cannon-fire/10">
                <Database className="w-5 h-5 text-cannon-fire" />
              </div>
              <span className="text-text-secondary text-sm">Full / Incremental</span>
            </div>
            <div className="text-2xl font-bold text-text-primary font-mono">
              {fullCount} / {incrCount}
            </div>
          </div>
          <div className="card-cannon p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 rounded-lg bg-cannon-tracer/10">
                <HardDrive className="w-5 h-5 text-cannon-tracer" />
              </div>
              <span className="text-text-secondary text-sm">Total Size</span>
            </div>
            <div className="text-2xl font-bold text-text-primary font-mono">
              {formatBytes(totalSize)}
            </div>
          </div>
          <div className="card-cannon p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 rounded-lg bg-cannon-ember/10">
                <Clock className="w-5 h-5 text-cannon-ember" />
              </div>
              <span className="text-text-secondary text-sm">Latest Backup</span>
            </div>
            <div className="text-sm font-bold text-text-primary font-mono">
              {formatDate(backups[0]?.timestamp)}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card-cannon p-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cannon-fire mx-auto mb-3" />
          <p className="text-text-secondary">Loading backups...</p>
        </div>
      ) : backups.length === 0 ? (
        <div className="card-cannon p-8 text-center">
          <Archive className="w-8 h-8 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No backups found</p>
          <p className="text-text-muted text-sm mt-1">
            Backups are created automatically at the scheduled times
          </p>
        </div>
      ) : (
        <div className="card-cannon overflow-hidden">
          <div className="px-4 py-3 bg-cannon-steel border-b border-cannon-graphite">
            <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <Archive className="w-5 h-5 text-cannon-fire" />
              Backup History
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-cannon-steel/50">
                <tr className="text-left text-text-secondary text-sm">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 text-right font-medium">Size</th>
                  <th className="px-4 py-3 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr
                    key={backup.name}
                    className="border-t border-cannon-graphite hover:bg-cannon-steel/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-sm text-text-primary">
                      {backup.name}
                    </td>
                    <td className="px-4 py-3">
                      <TypeBadge type={backup.type} />
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {formatDate(backup.timestamp)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm text-cannon-fire tabular-nums">
                      {backup.size_formatted || formatBytes(backup.size)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1.5 text-sm text-cannon-tracer">
                        <CheckCircle2 className="w-4 h-4" />
                        Completed
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
