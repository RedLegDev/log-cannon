'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { Widget } from '@/lib/clickhouse';

interface BarChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function BarChartWidget({ data, widget }: BarChartWidgetProps) {
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
  const color = config?.colors?.[0] || '#FF3366';

  const chartData = useMemo(() => {
    if (!yField) return null;

    const yFields = Array.isArray(yField) ? yField : [yField];
    const yKey = yFields[0];

    return (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        name: String(record[xField] ?? ''),
        value: Number(record[yKey]) || 0,
      };
    });
  }, [data, xField, yField]);

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for bar chart
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
      <BarChart
        width={size.width}
        height={size.height}
        data={chartData}
        layout="vertical"
        margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
      >
        <XAxis type="number" stroke="#666" fontSize={12} />
        <YAxis
          type="category"
          dataKey="name"
          stroke="#666"
          fontSize={12}
          width={100}
        />
        <Tooltip />
        <Bar dataKey="value" fill={color} />
      </BarChart>
    </div>
  );
}
