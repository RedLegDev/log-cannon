'use client';

import { Widget } from '@/lib/clickhouse';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface PieChartWidgetProps {
  data: unknown[];
  widget: Widget;
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
  const chartData = (data as Record<string, unknown>[]).map((item) => ({
    name: String(item[nameField] ?? 'Unknown'),
    value: Number(item[valueField]) || 0,
  }));

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
    <div className="flex-grow">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <Pie
            data={filteredData}
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
            {filteredData.map((_, index) => (
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
  );
}
