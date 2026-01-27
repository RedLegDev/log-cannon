'use client';

import { Widget } from '@/lib/clickhouse';
import { WidgetContainer } from './WidgetContainer';
import { StatWidget } from './widgets/StatWidget';
import { LineChartWidget } from './widgets/LineChartWidget';
import { BarChartWidget } from './widgets/BarChartWidget';
import { TableWidget } from './widgets/TableWidget';
import { PieChartWidget } from './widgets/PieChartWidget';

interface WidgetRendererProps {
  widget: Widget;
  dashboardName: string;
}

export function WidgetRenderer({ widget, dashboardName }: WidgetRendererProps) {
  return (
    <WidgetContainer widget={widget} dashboardName={dashboardName}>
      {(data) => {
        switch (widget.type) {
          case 'stat':
            return <StatWidget data={data} widget={widget} />;
          case 'line_chart':
            return <LineChartWidget data={data} widget={widget} />;
          case 'bar_chart':
            return <BarChartWidget data={data} widget={widget} />;
          case 'pie_chart':
            return <PieChartWidget data={data} widget={widget} />;
          case 'table':
            return <TableWidget data={data} widget={widget} />;
          default:
            return (
              <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
                Unknown widget type: {widget.type}
              </div>
            );
        }
      }}
    </WidgetContainer>
  );
}
