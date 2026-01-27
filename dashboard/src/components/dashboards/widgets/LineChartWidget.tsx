'use client';

import dynamic from 'next/dynamic';
import { Widget } from '@/lib/clickhouse';
import { ChartWrapper } from './ChartWrapper';

// Dynamic import for Recharts - SSR disabled since it uses browser APIs
const RechartsLineChartInner = dynamic(
  () => import('./RechartsLineChartInner').then(mod => mod.RechartsLineChartInner),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-text-muted">
        <div className="animate-pulse">Loading chart...</div>
      </div>
    ),
  }
);

interface LineChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export interface LineChartData {
  name: string;
  value: number;
  originalLabel: string;
}

export function LineChartWidget({ data, widget }: LineChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || ['#FF4D2A'];

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for line chart
      </div>
    );
  }

  const yFields = Array.isArray(yField) ? yField : [yField];
  const yKey = yFields[0];

  // Transform data
  const chartData: LineChartData[] = (Array.isArray(data) ? data : []).map((item) => {
    const record = item as Record<string, unknown>;
    const label = String(record[xField] ?? '');
    return {
      name: formatLabel(label),
      value: Number(record[yKey]) || 0,
      originalLabel: label,
    };
  });

  if (chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  return (
    <ChartWrapper>
      {(dimensions) => (
        <RechartsLineChartInner
          data={chartData}
          width={dimensions.width}
          height={dimensions.height}
          colors={colors}
        />
      )}
    </ChartWrapper>
  );
}

// Format time label for display
function formatLabel(label: string): string {
  try {
    const date = new Date(label);
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  } catch {
    // Not a date
  }
  return label;
}
