'use client';

import dynamic from 'next/dynamic';
import { Widget } from '@/lib/clickhouse';
import { ChartWrapper } from './ChartWrapper';

// Dynamic import for Recharts - SSR disabled since it uses browser APIs
const RechartsPieChartInner = dynamic(
  () => import('./RechartsPieChartInner').then(mod => mod.RechartsPieChartInner),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-text-muted">
        <div className="animate-pulse">Loading chart...</div>
      </div>
    ),
  }
);

interface PieChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export interface PieChartData {
  name: string;
  value: number;
}

const DEFAULT_COLORS = [
  '#FF4D2A', // cannon-fire
  '#FF3366', // pinkish-red
  '#36A2EB', // blue
  '#FFCE56', // yellow
  '#4BC0C0', // teal
  '#9966FF', // purple
  '#FF9F40', // orange
  '#C9CBCF', // gray
];

export function PieChartWidget({ data, widget }: PieChartWidgetProps) {
  const config = widget.visualization;
  const nameField = config?.xField || 'name';
  const valueField = config?.yField;
  const colors = config?.colors || DEFAULT_COLORS;

  if (!valueField || Array.isArray(valueField)) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        Pie chart requires a single yField configured
      </div>
    );
  }

  // Transform data to ensure numeric values
  const chartData: PieChartData[] = (Array.isArray(data) ? data : []).map((item) => {
    const record = item as Record<string, unknown>;
    return {
      name: String(record[nameField] ?? 'Unknown'),
      value: Number(record[valueField]) || 0,
    };
  });

  // Filter out zero values for cleaner display
  const filteredData = chartData.filter((item) => item.value > 0);

  if (filteredData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data available
      </div>
    );
  }

  return (
    <ChartWrapper>
      {(dimensions) => (
        <RechartsPieChartInner
          data={filteredData}
          width={dimensions.width}
          height={dimensions.height}
          colors={colors}
        />
      )}
    </ChartWrapper>
  );
}
