'use client';

import { DashboardConfig } from '@/lib/clickhouse';
import { WidgetRenderer } from './WidgetRenderer';

interface DashboardGridProps {
  config: DashboardConfig;
  dashboardName: string;
}

export function DashboardGrid({ config, dashboardName }: DashboardGridProps) {
  if (config.layout === 'grid') {
    // Grid layout with positioned widgets
    return (
      <div className="grid grid-cols-12 gap-4 auto-rows-[200px]">
        {config.widgets.map((widget) => {
          const position = widget.position || { row: 1, col: 1, width: 12, height: 1 };

          return (
            <div
              key={widget.id}
              className="min-h-0"
              style={{
                gridColumn: `span ${position.width}`,
                gridRow: `span ${position.height}`,
              }}
            >
              <WidgetRenderer widget={widget} dashboardName={dashboardName} />
            </div>
          );
        })}
      </div>
    );
  } else {
    // Auto layout - simple responsive grid
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-[300px]">
        {config.widgets.map((widget) => (
          <div key={widget.id} className="min-h-0">
            <WidgetRenderer widget={widget} dashboardName={dashboardName} />
          </div>
        ))}
      </div>
    );
  }
}
