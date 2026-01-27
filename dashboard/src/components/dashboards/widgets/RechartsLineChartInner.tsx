'use client';

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { LineChartData } from './LineChartWidget';

interface RechartsLineChartInnerProps {
  data: LineChartData[];
  width: number;
  height: number;
  colors: string[];
}

export function RechartsLineChartInner({ data, width, height, colors }: RechartsLineChartInnerProps) {
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis
            dataKey="name"
            stroke="#666"
            fontSize={12}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#666"
            fontSize={12}
            tickLine={false}
            tickFormatter={(value) => value.toLocaleString()}
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
          <Line
            type="monotone"
            dataKey="value"
            stroke={colors[0]}
            strokeWidth={2}
            dot={data.length <= 30}
            activeDot={{ r: 6, fill: colors[0] }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
