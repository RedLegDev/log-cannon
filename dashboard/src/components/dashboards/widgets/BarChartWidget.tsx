'use client';

import dynamic from 'next/dynamic';
import { Widget } from '@/lib/clickhouse';
import { ChartWrapper } from './ChartWrapper';

// Dynamic import for Recharts - SSR disabled since it uses browser APIs
const RechartsBarChartInner = dynamic(
  () => import('./RechartsBarChartInner').then(mod => mod.RechartsBarChartInner),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-text-muted">
        <div className="animate-pulse">Loading chart...</div>
      </div>
    ),
  }
);

interface BarChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export interface BarChartData {
  name: string;
  value: number;
}

export function BarChartWidget({ data, widget }: BarChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || ['#FF3366', '#FF4D2A', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'];

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for bar chart
      </div>
    );
  }

  const yFields = Array.isArray(yField) ? yField : [yField];
  const yKey = yFields[0];

  // Transform data
  const chartData: BarChartData[] = (Array.isArray(data) ? data : []).map((item) => {
    const record = item as Record<string, unknown>;
    return {
      name: String(record[xField] ?? ''),
      value: Number(record[yKey]) || 0,
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
        <RechartsBarChartInner
          data={chartData}
          width={dimensions.width}
          height={dimensions.height}
          colors={colors}
        />
      )}
    </ChartWrapper>
  );
}
