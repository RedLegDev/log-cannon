'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Widget } from '@/lib/clickhouse';
import { ChartWrapper } from './ChartWrapper';

interface BarChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

const DEFAULT_COLORS = ['#FF3366', '#FF4D2A', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'];

export function BarChartWidget({ data, widget }: BarChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || DEFAULT_COLORS;

  const chartData = useMemo(() => {
    if (!yField) return null;

    const yFields = Array.isArray(yField) ? yField : [yField];
    const yKey = yFields[0];

    return (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        name: String(record[xField] ?? ''),
        value: Number(record[yKey]) || 0,
      };
    });
  }, [data, xField, yField]);

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for bar chart
      </div>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  return (
    <ChartWrapper>
      {(dimensions) => (
        <div style={{ width: dimensions.width, height: dimensions.height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
            >
              <XAxis type="number" stroke="#666" fontSize={12} />
              <YAxis
                type="category"
                dataKey="name"
                stroke="#666"
                fontSize={12}
                width={100}
                tickFormatter={(value) => value.length > 15 ? `${value.slice(0, 15)}...` : value}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: '4px',
                  color: '#fff',
                }}
                formatter={(value: number) => [value.toLocaleString(), 'Value']}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {chartData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartWrapper>
  );
}
