'use client';

import { Dashboard, DashboardConfig } from '@/lib/clickhouse';
import { DashboardGrid } from './DashboardGrid';
import { AlertCircle } from 'lucide-react';

interface DashboardViewProps {
  dashboard: Dashboard;
}

export function DashboardView({ dashboard }: DashboardViewProps) {
  let config: DashboardConfig;

  try {
    config = JSON.parse(dashboard.config);
  } catch (error) {
    return (
      <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-cannon-critical flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium text-cannon-critical">Invalid Dashboard Configuration</h3>
            <p className="text-text-secondary text-sm mt-1">
              Failed to parse dashboard config: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!config.widgets || config.widgets.length === 0) {
    return (
      <div className="card-cannon p-6 text-center">
        <p className="text-text-muted">This dashboard has no widgets configured.</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <DashboardGrid config={config} dashboardName={dashboard.name} />
    </div>
  );
}
