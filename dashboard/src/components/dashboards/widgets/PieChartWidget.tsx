'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { PieChart, Pie, Tooltip } from 'recharts';
import { Widget } from '@/lib/clickhouse';

interface PieChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function PieChartWidget({ data, widget }: PieChartWidgetProps) {
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
  const nameField = config?.xField || 'name';
  const valueField = config?.yField;

  const chartData = useMemo(() => {
    if (!valueField || Array.isArray(valueField)) return null;

    const items = (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        name: String(record[nameField] ?? 'Unknown'),
        value: Number(record[valueField]) || 0,
      };
    });

    return items.filter((item) => item.value > 0);
  }, [data, nameField, valueField]);

  if (!valueField || Array.isArray(valueField)) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        Pie chart requires a single yField configured
      </div>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data available
      </div>
    );
  }

  const outerRadius = Math.min(size.width, size.height) * 0.35;

  return (
    <div ref={containerRef} className="w-full h-full">
      <PieChart width={size.width} height={size.height}>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={outerRadius}
          fill="#FF4D2A"
          label
        />
        <Tooltip />
      </PieChart>
    </div>
  );
}
