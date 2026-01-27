'use client';

import { useState, useEffect, useCallback } from 'react';
import { Widget } from '@/lib/clickhouse';
import { RefreshCw, AlertCircle } from 'lucide-react';

interface WidgetContainerProps {
  widget: Widget;
  dashboardName: string;
  children: (data: unknown[]) => React.ReactNode;
}

export function WidgetContainer({ widget, dashboardName, children }: WidgetContainerProps) {
  const [data, setData] = useState<unknown[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/dashboards/${dashboardName}/widgets/${widget.id}`);
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to fetch widget data');
      }

      setData(result.data);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [dashboardName, widget.id]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh
  useEffect(() => {
    if (!widget.dataSource.refreshInterval || widget.dataSource.refreshInterval <= 0) {
      return;
    }

    const intervalId = setInterval(() => {
      fetchData();
    }, widget.dataSource.refreshInterval * 1000);

    return () => clearInterval(intervalId);
  }, [widget.dataSource.refreshInterval, fetchData]);

  return (
    <div className="card-cannon p-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-medium text-text-primary">{widget.title}</h3>
        <button
          onClick={() => fetchData()}
          disabled={loading}
          className="text-text-muted hover:text-text-secondary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-grow flex flex-col min-h-0">
        {loading && !data ? (
          /* Initial loading skeleton */
          <div className="flex-grow flex items-center justify-center">
            <div className="animate-pulse text-text-muted">Loading...</div>
          </div>
        ) : error ? (
          /* Error state */
          <div className="flex-grow flex flex-col items-center justify-center text-center p-4">
            <AlertCircle className="w-8 h-8 text-cannon-critical mb-2" />
            <p className="text-cannon-critical font-medium mb-2">Error loading widget</p>
            <p className="text-text-secondary text-sm mb-3">{error}</p>
            <button
              onClick={() => fetchData()}
              className="btn-cannon text-sm"
            >
              Retry
            </button>
          </div>
        ) : data && data.length === 0 ? (
          /* Empty state */
          <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
            No data available
          </div>
        ) : data ? (
          /* Render widget content */
          <div className="flex-grow flex flex-col min-h-0">
            {children(data)}
          </div>
        ) : null}
      </div>

      {/* Footer with last refreshed time */}
      {lastRefreshed && !error && (
        <div className="mt-3 pt-3 border-t border-border-subtle text-xs text-text-muted">
          Last updated: {lastRefreshed.toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
