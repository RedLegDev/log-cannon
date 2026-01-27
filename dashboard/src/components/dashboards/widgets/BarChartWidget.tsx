'use client';

import { Widget } from '@/lib/clickhouse';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface BarChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function BarChartWidget({ data, widget }: BarChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || ['#FF3366']; // Default to pinkish-red

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for bar chart
      </div>
    );
  }

  // Support multiple y fields
  const yFields = Array.isArray(yField) ? yField : [yField];

  // Transform data to ensure numeric values for y fields (like PieChartWidget does)
  const chartData = (Array.isArray(data) ? data : []).map((item) => {
    const record = item as Record<string, unknown>;
    const transformed: Record<string, unknown> = {};
    // Keep x field as string
    transformed[xField] = String(record[xField] ?? '');
    // Ensure y fields are numbers
    for (const field of yFields) {
      transformed[field] = Number(record[field]) || 0;
    }
    return transformed;
  });

  if (chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  const maxValue = Math.max(...chartData.map(d => Number(d[yFields[0]]) || 0));

  // Simple CSS bar chart as fallback (Recharts not rendering for unknown reason)
  return (
    <div className="flex-grow flex flex-col gap-2 overflow-hidden">
      {chartData.slice(0, 8).map((item, idx) => {
        const label = String(item[xField]);
        const value = Number(item[yFields[0]]) || 0;
        const percentage = maxValue > 0 ? (value / maxValue) * 100 : 0;
        return (
          <div key={idx} className="flex items-center gap-2 text-xs">
            <div className="w-24 truncate text-gray-400" title={label}>
              {label}
            </div>
            <div className="flex-grow h-5 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full rounded"
                style={{
                  width: `${percentage}%`,
                  backgroundColor: colors[idx % colors.length],
                }}
              />
            </div>
            <div className="w-20 text-right text-gray-400">
              {value.toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
