'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';

const REFRESH_INTERVAL_MS = 30_000;

export function AutoRefreshToggle() {
  const [enabled, setEnabled] = useState(false);

  const dispatchRefresh = useCallback(() => {
    window.dispatchEvent(new CustomEvent('dashboard-refresh'));
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const intervalId = setInterval(dispatchRefresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [enabled, dispatchRefresh]);

  return (
    <button
      onClick={() => setEnabled((prev) => !prev)}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
        enabled
          ? 'bg-cannon-fire/10 text-cannon-fire border border-cannon-fire/30'
          : 'text-text-secondary hover:text-text-primary border border-border-subtle hover:border-border-default'
      }`}
      title={enabled ? 'Auto-refresh on (every 30s)' : 'Enable auto-refresh'}
    >
      <RefreshCw className={`w-3.5 h-3.5 ${enabled ? 'animate-spin' : ''}`} />
      Auto
    </button>
  );
}
