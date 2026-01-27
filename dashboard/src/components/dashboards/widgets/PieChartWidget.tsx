'use client';

import { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Widget } from '@/lib/clickhouse';
import { ChartWrapper } from './ChartWrapper';

interface PieChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

const DEFAULT_COLORS = [
  '#FF4D2A',
  '#FF3366',
  '#36A2EB',
  '#FFCE56',
  '#4BC0C0',
  '#9966FF',
  '#FF9F40',
  '#C9CBCF',
];

export function PieChartWidget({ data, widget }: PieChartWidgetProps) {
  const config = widget.visualization;
  const nameField = config?.xField || 'name';
  const valueField = config?.yField;
  const colors = config?.colors || DEFAULT_COLORS;

  const chartData = useMemo(() => {
    if (!valueField || Array.isArray(valueField)) return null;

    const items = (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        name: String(record[nameField] ?? 'Unknown'),
        value: Number(record[valueField]) || 0,
      };
    });

    // Filter out zero values
    return items.filter((item) => item.value > 0);
  }, [data, nameField, valueField]);

  if (!valueField || Array.isArray(valueField)) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        Pie chart requires a single yField configured
      </div>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data available
      </div>
    );
  }

  return (
    <ChartWrapper>
      {(dimensions) => (
        <div style={{ width: dimensions.width, height: dimensions.height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius="70%"
                label={({ name, percent }) =>
                  `${name}: ${(percent * 100).toFixed(0)}%`
                }
                labelLine={{ stroke: '#888' }}
              >
                {chartData.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={colors[index % colors.length]}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: '4px',
                  color: '#fff',
                }}
                formatter={(value: number) => [value.toLocaleString(), 'Count']}
              />
              <Legend
                wrapperStyle={{ color: '#888' }}
                formatter={(value) => <span style={{ color: '#888' }}>{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartWrapper>
  );
}
