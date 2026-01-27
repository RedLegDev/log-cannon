'use client';

import { BarChart, Bar, XAxis, YAxis } from 'recharts';
import { Widget } from '@/lib/clickhouse';

interface BarChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

const TEST_DATA = [
  { name: 'A', value: 100 },
  { name: 'B', value: 200 },
  { name: 'C', value: 150 },
];

export function BarChartWidget({ data, widget }: BarChartWidgetProps) {
  // Ignore props for now, just test if Recharts works at all
  void data;
  void widget;

  return (
    <BarChart width={400} height={200} data={TEST_DATA}>
      <XAxis dataKey="name" />
      <YAxis />
      <Bar dataKey="value" fill="#FF3366" />
    </BarChart>
  );
}
