'use client';

import { useMemo } from 'react';
import { Pie } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Widget } from '@/lib/clickhouse';

ChartJS.register(ArcElement, Title, Tooltip, Legend);

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

    const items = (Array.isArray(data) ? data : [])
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          label: String(record[nameField] ?? 'Unknown'),
          value: Number(record[valueField]) || 0,
        };
      })
      .filter((item) => item.value > 0);

    return {
      labels: items.map((i) => i.label),
      datasets: [
        {
          data: items.map((i) => i.value),
          backgroundColor: items.map((_, idx) => colors[idx % colors.length]),
          borderColor: '#1a1a1a',
          borderWidth: 2,
        },
      ],
    };
  }, [data, nameField, valueField, colors]);

  if (!valueField || Array.isArray(valueField)) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        Pie chart requires a single yField configured
      </div>
    );
  }

  if (!chartData || chartData.labels.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data available
      </div>
    );
  }

  return (
    <div className="w-full h-full flex items-center justify-center">
      <Pie
        data={chartData}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: '#888' },
            },
          },
        }}
      />
    </div>
  );
}
