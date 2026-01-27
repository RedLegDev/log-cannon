'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { Widget } from '@/lib/clickhouse';

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
  const colors = config?.colors || DEFAULT_COLORS;

  const chartData = useMemo(() => {
    if (!valueField || Array.isArray(valueField)) return null;

    const items = (Array.isArray(data) ? data : []).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        name: String(record[nameField] ?? 'Unknown'),
        value: Number(record[valueField]) || 0,
      };
    });

    // Filter out zero values
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
          label={({ name, percent }) =>
            `${name}: ${(percent * 100).toFixed(0)}%`
          }
          labelLine={{ stroke: '#888' }}
        >
          {chartData.map((_, index) => (
            <Cell
              key={`cell-${index}`}
              fill={colors[index % colors.length]}
            />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '4px',
            color: '#fff',
          }}
          formatter={(value: number) => [value.toLocaleString(), 'Count']}
        />
        <Legend
          wrapperStyle={{ color: '#888' }}
          formatter={(value) => <span style={{ color: '#888' }}>{value}</span>}
        />
      </PieChart>
    </div>
  );
}
