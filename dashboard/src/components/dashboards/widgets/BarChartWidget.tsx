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
  const colors = config?.colors || ['#FF3366'];

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for bar chart
      </div>
    );
  }

  const yFields = Array.isArray(yField) ? yField : [yField];

  // Transform data
  const chartData = (Array.isArray(data) ? data : []).map((item) => {
    const record = item as Record<string, unknown>;
    return {
      [xField]: String(record[xField] ?? ''),
      [yFields[0]]: Number(record[yFields[0]]) || 0,
    };
  });

  if (chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  // Debug info
  console.log('BarChart chartData:', JSON.stringify(chartData));
  console.log('BarChart xField:', xField, 'yField:', yFields[0]);

  // Skip ResponsiveContainer - use fixed dimensions directly
  return (
    <div className="w-full overflow-x-auto">
      <BarChart width={500} height={200} data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey={xField} stroke="#888" tick={{ fill: '#888', fontSize: 11 }} />
        <YAxis stroke="#888" tick={{ fill: '#888', fontSize: 11 }} />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '4px',
            color: '#fff'
          }}
        />
        <Bar dataKey={yFields[0]} fill={colors[0]} />
      </BarChart>
    </div>
  );
}
