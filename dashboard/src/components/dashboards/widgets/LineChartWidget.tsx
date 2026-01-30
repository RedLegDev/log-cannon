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

const DEFAULT_COLORS = [
  '#FF4D2A', // Orange-red (primary)
  '#3B82F6', // Blue
  '#10B981', // Green
  '#F59E0B', // Amber
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#84CC16', // Lime
];

interface LineChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function LineChartWidget({ data, widget }: LineChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;

  const chartData = useMemo(() => {
    if (!yField) return null;

    const yFields = Array.isArray(yField) ? yField : [yField];
    const colors = config?.colors || DEFAULT_COLORS;
    const dataArray = Array.isArray(data) ? data : [];

    const labels = dataArray.map((item) => {
      const record = item as Record<string, unknown>;
      return formatLabel(String(record[xField] ?? ''));
    });

    const datasets = yFields.map((field, index) => {
      const fieldColor = colors[index % colors.length];
      return {
        label: field,
        data: dataArray.map((item) => {
          const record = item as Record<string, unknown>;
          return Number(record[field]) || 0;
        }),
        borderColor: fieldColor,
        backgroundColor: fieldColor + '20',
        fill: yFields.length === 1,
        tension: 0.3,
        pointRadius: dataArray.length > 30 ? 0 : 3,
      };
    });

    return { labels, datasets };
  }, [data, xField, yField, config?.colors]);

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

  const showLegend = chartData.datasets.length > 1;

  return (
    <div className="w-full h-full">
      <Line
        data={chartData}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: showLegend,
              position: 'top',
              labels: { color: '#888', boxWidth: 12, padding: 8 },
            },
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
