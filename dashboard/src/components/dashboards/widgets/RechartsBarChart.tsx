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

  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis
            dataKey={xField}
            stroke="#888"
            tick={{ fill: '#888', fontSize: 11 }}
          />
          <YAxis
            stroke="#888"
            tick={{ fill: '#888', fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: '4px',
              color: '#fff',
            }}
          />
          <Bar dataKey={yKey} fill={colors[0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
