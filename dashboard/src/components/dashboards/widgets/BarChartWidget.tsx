'use client';

import { Widget } from '@/lib/clickhouse';
import dynamic from 'next/dynamic';

interface BarChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

// Dynamically import Recharts with SSR disabled
const RechartsBarChart = dynamic(
  () => import('./RechartsBarChart').then(mod => mod.RechartsBarChart),
  {
    ssr: false,
    loading: () => <div className="flex-grow flex items-center justify-center text-text-muted">Loading chart...</div>
  }
);

export function BarChartWidget({ data, widget }: BarChartWidgetProps) {
  return <RechartsBarChart data={data} widget={widget} />;
}
