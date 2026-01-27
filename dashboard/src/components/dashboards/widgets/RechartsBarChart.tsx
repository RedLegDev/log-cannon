'use client';

import { Widget } from '@/lib/clickhouse';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface RechartsBarChartProps {
  data: unknown[];
  widget: Widget;
}

export function RechartsBarChart({ data, widget }: RechartsBarChartProps) {
  console.log('RechartsBarChart render - data:', data, 'widget:', widget);

  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || ['#FF3366'];

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
  const chartData = (Array.isArray(data) ? data : []).map((item) => {
    const record = item as Record<string, unknown>;
    return {
      [xField]: String(record[xField] ?? ''),
      [yKey]: Number(record[yKey]) || 0,
    };
  });

  if (chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  console.log('chartData:', chartData, 'xField:', xField, 'yKey:', yKey);

  // Absolute minimum - no formatters, no custom tick props
  return (
    <div className="overflow-x-auto">
      <BarChart width={450} height={200} data={chartData}>
        <XAxis dataKey={xField} />
        <YAxis />
        <Bar dataKey={yKey} fill="#FF3366" />
      </BarChart>
    </div>
  );
}
