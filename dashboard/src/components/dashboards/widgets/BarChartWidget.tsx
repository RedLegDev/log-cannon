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

  // Debug: show data count
  const maxValue = Math.max(...chartData.map(d => Number(d[yFields[0]]) || 0));

  return (
    <div className="flex-grow flex flex-col">
      <div className="text-xs text-gray-500 mb-1">
        Debug: {chartData.length} items, max={maxValue.toLocaleString()}
      </div>
      <div className="flex-grow" style={{ minHeight: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey={xField}
              stroke="#888"
              tick={{ fill: '#888' }}
            />
            <YAxis stroke="#888" tick={{ fill: '#888' }} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '4px',
                color: '#fff'
              }}
            />
            {yFields.map((field, idx) => (
              <Bar
                key={field}
                dataKey={field}
                fill={colors[idx % colors.length]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
