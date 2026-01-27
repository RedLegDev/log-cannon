'use client';

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { BarChartData } from './BarChartWidget';

interface RechartsBarChartInnerProps {
  data: BarChartData[];
  width: number;
  height: number;
  colors: string[];
}

export function RechartsBarChartInner({ data, width, height, colors }: RechartsBarChartInnerProps) {
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
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
            labelFormatter={(label) => label}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {data.map((_, index) => (
              <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
