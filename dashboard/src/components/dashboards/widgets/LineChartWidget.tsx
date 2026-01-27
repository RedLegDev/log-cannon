'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Widget } from '@/lib/clickhouse';

interface LineChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function LineChartWidget({ data, widget }: LineChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 400, height: 200 });

  useEffect(() => {
    if (!containerRef.current) return;

    const updateSize = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        if (width > 0 && height > 0) {
          setSize({ width, height });
        }
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const color = config?.colors?.[0] || '#FF4D2A';

  const chartData = useMemo(() => {
    if (!yField) return null;

    const yFields = Array.isArray(yField) ? yField : [yField];
    const yKey = yFields[0];

    return (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      const label = String(record[xField] ?? '');
      return {
        name: formatLabel(label),
        value: Number(record[yKey]) || 0,
      };
    });
  }, [data, xField, yField]);

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for line chart
      </div>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full">
      <LineChart
        width={size.width}
        height={size.height}
        data={chartData}
        margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="name" stroke="#666" fontSize={12} />
        <YAxis stroke="#666" fontSize={12} />
        <Tooltip />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
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
