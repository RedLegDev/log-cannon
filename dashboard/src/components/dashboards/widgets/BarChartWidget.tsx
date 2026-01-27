'use client';

import { useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Widget } from '@/lib/clickhouse';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

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

    const items = (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        label: String(record[xField] ?? ''),
        value: Number(record[yKey]) || 0,
      };
    });

    return {
      labels: items.map((i) => i.label),
      datasets: [
        {
          data: items.map((i) => i.value),
          backgroundColor: items.map((_, idx) => colors[idx % colors.length]),
          borderRadius: 4,
        },
      ],
    };
  }, [data, xField, yField, colors]);

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for bar chart
      </div>
    );
  }

  if (!chartData || chartData.labels.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <Bar
        data={chartData}
        options={{
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
          },
          scales: {
            x: {
              grid: { color: '#333' },
              ticks: { color: '#888' },
            },
            y: {
              grid: { display: false },
              ticks: { color: '#888' },
            },
          },
        }}
      />
    </div>
  );
}
