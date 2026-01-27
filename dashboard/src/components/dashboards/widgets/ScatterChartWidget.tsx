'use client';

import { useMemo } from 'react';
import { Scatter } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Widget } from '@/lib/clickhouse';

ChartJS.register(LinearScale, PointElement, Title, Tooltip, Legend);

interface ScatterChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

const DEFAULT_COLOR = '#FF4D2A';

export function ScatterChartWidget({ data, widget }: ScatterChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const color = config?.colors?.[0] || DEFAULT_COLOR;

  const chartData = useMemo(() => {
    if (!yField || Array.isArray(yField)) return null;

    const points = (Array.isArray(data) ? data : [])
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          x: Number(record[xField]) || 0,
          y: Number(record[yField]) || 0,
        };
      })
      .filter((point) => !isNaN(point.x) && !isNaN(point.y));

    return {
      datasets: [
        {
          data: points,
          backgroundColor: color + '80',
          borderColor: color,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    };
  }, [data, xField, yField, color]);

  if (!yField || Array.isArray(yField)) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        Scatter chart requires xField and yField configured (both numeric)
      </div>
    );
  }

  if (!chartData || chartData.datasets[0].data.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data available
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <Scatter
        data={chartData}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const point = context.raw as { x: number; y: number };
                  return `${xField}: ${point.x}, ${yField}: ${point.y}`;
                },
              },
            },
          },
          scales: {
            x: {
              title: {
                display: true,
                text: xField,
                color: '#888',
              },
              grid: { color: '#333' },
              ticks: { color: '#888' },
            },
            y: {
              title: {
                display: true,
                text: yField,
                color: '#888',
              },
              grid: { color: '#333' },
              ticks: { color: '#888' },
            },
          },
        }}
      />
    </div>
  );
}
