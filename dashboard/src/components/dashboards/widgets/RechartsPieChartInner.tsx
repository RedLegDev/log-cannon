'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { PieChartData } from './PieChartWidget';

interface RechartsPieChartInnerProps {
  data: PieChartData[];
  width: number;
  height: number;
  colors: string[];
}

export function RechartsPieChartInner({ data, width, height, colors }: RechartsPieChartInnerProps) {
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <Pie
            data={data}
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
            {data.map((_, index) => (
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
