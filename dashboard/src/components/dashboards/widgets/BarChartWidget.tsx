'use client';

import { Widget } from '@/lib/clickhouse';

interface BarChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function BarChartWidget({ data, widget }: BarChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || ['#FF3366', '#FF4D2A', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'];

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for bar chart
      </div>
    );
  }

  const yFields = Array.isArray(yField) ? yField : [yField];
  const yKey = yFields[0];

  // Transform data
  const chartData = (Array.isArray(data) ? data : []).map((item) => {
    const record = item as Record<string, unknown>;
    return {
      label: String(record[xField] ?? ''),
      value: Number(record[yKey]) || 0,
    };
  });

  if (chartData.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data to display
      </div>
    );
  }

  const maxValue = Math.max(...chartData.map(d => d.value));

  return (
    <div className="flex-grow flex flex-col gap-2 overflow-hidden">
      {chartData.slice(0, 10).map((item, idx) => {
        const percentage = maxValue > 0 ? (item.value / maxValue) * 100 : 0;
        return (
          <div key={idx} className="flex items-center gap-2 text-xs">
            <div className="w-28 truncate text-gray-400 text-right pr-2" title={item.label}>
              {item.label}
            </div>
            <div className="flex-grow h-5 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full rounded transition-all duration-300"
                style={{
                  width: `${percentage}%`,
                  backgroundColor: colors[idx % colors.length],
                }}
              />
            </div>
            <div className="w-20 text-right text-gray-400 font-mono">
              {item.value.toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
