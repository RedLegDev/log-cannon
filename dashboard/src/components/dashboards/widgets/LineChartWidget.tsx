'use client';

import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Widget } from '@/lib/clickhouse';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

interface LineChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function LineChartWidget({ data, widget }: LineChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const color = config?.colors?.[0] || '#FF4D2A';

  const chartData = useMemo(() => {
    if (!yField) return null;

    const yFields = Array.isArray(yField) ? yField : [yField];
    const yKey = yFields[0];

    const items = (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      const label = String(record[xField] ?? '');
      return {
        label: formatLabel(label),
        value: Number(record[yKey]) || 0,
      };
    });

    return {
      labels: items.map((i) => i.label),
      datasets: [
        {
          data: items.map((i) => i.value),
          borderColor: color,
          backgroundColor: color + '20',
          fill: true,
          tension: 0.3,
          pointRadius: items.length > 30 ? 0 : 3,
        },
      ],
    };
  }, [data, xField, yField, color]);

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for line chart
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
      <Line
        data={chartData}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
          },
          scales: {
            x: {
              grid: { color: '#333' },
              ticks: { color: '#888', maxTicksLimit: 8 },
            },
            y: {
              grid: { color: '#333' },
              ticks: { color: '#888' },
            },
          },
        }}
      />
    </div>
  );
}

function formatLabel(label: string): string {
  try {
    const date = new Date(label);
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  } catch {
    // Not a date
  }
  return label;
}
