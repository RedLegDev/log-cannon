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

    const xAxisFormat = config?.xAxisFormat || 'auto';
    const rawLabels = dataArray.map((item) => {
      const record = item as Record<string, unknown>;
      return String(record[xField] ?? '');
    });
    const labels = formatLabels(rawLabels, xAxisFormat);

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

function formatLabels(labels: string[], format: string): string[] {
  if (format === 'string') return labels;

  // Parse all labels as dates
  const parsed = labels.map((label) => {
    try {
      const date = new Date(label);
      return !isNaN(date.getTime()) ? date : null;
    } catch {
      return null;
    }
  });

  // If not all labels are valid dates, return as-is
  if (parsed.some((d) => d === null)) return labels;
  const dates = parsed as Date[];

  if (format === 'time') {
    return dates.map((d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  }
  if (format === 'date') {
    return dates.map((d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' }));
  }
  if (format === 'datetime') {
    return dates.map((d) =>
      d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
  }

  // Auto-detect: check if data spans multiple days
  if (dates.length >= 2) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    const spanMs = Math.abs(last.getTime() - first.getTime());
    const spanHours = spanMs / (1000 * 60 * 60);

    if (spanHours >= 48) {
      // Multi-day: show date only
      return dates.map((d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' }));
    } else if (spanHours >= 2) {
      // Same day or spanning overnight: show time
      return dates.map((d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    }
  }

  // Default: time only
  return dates.map((d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}
