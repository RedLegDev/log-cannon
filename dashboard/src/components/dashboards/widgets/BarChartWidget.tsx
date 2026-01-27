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

  return (
    <div className="flex-grow">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
  );
}
