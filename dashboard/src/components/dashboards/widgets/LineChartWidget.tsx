'use client';

import { Widget } from '@/lib/clickhouse';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface LineChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function LineChartWidget({ data, widget }: LineChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || ['#FF4D2A']; // Default to cannon-fire color

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for line chart
      </div>
    );
  }

  // Support multiple y fields
  const yFields = Array.isArray(yField) ? yField : [yField];

  return (
    <div className="flex-grow">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis
            dataKey={xField}
            stroke="#888"
            tick={{ fill: '#888' }}
            tickFormatter={(value) => {
              // Try to format as time if it looks like a timestamp
              try {
                const date = new Date(value);
                if (!isNaN(date.getTime())) {
                  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
              } catch {
                // Not a date, return as is
              }
              return value;
            }}
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
            <Line
              key={field}
              type="monotone"
              dataKey={field}
              stroke={colors[idx % colors.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
