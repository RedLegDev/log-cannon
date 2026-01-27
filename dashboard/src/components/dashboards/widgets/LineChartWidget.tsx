'use client';

import { Widget } from '@/lib/clickhouse';

interface LineChartWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function LineChartWidget({ data, widget }: LineChartWidgetProps) {
  const config = widget.visualization;
  const xField = config?.xField || 'x';
  const yField = config?.yField;
  const colors = config?.colors || ['#FF4D2A'];

  if (!yField) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No yField configured for line chart
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
  const minValue = Math.min(...chartData.map(d => d.value));
  const range = maxValue - minValue || 1;

  // Format time label
  const formatLabel = (label: string) => {
    try {
      const date = new Date(label);
      if (!isNaN(date.getTime())) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch {
      // Not a date
    }
    return label;
  };

  return (
    <div className="flex-grow flex flex-col">
      {/* Chart area */}
      <div className="flex-grow flex items-end gap-0.5 min-h-[160px]">
        {chartData.map((item, idx) => {
          const height = ((item.value - minValue) / range) * 100;
          return (
            <div
              key={idx}
              className="flex-1 flex flex-col justify-end group cursor-pointer relative"
              title={`${formatLabel(item.label)}: ${item.value.toLocaleString()}`}
            >
              <div
                className="w-full rounded-t transition-all duration-200 group-hover:opacity-80"
                style={{
                  height: `${Math.max(height, 2)}%`,
                  backgroundColor: colors[0],
                  opacity: 0.8,
                }}
              />
              {/* Hover tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-xs text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                {item.value.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>
      {/* X-axis labels */}
      <div className="flex justify-between text-xs text-gray-500 mt-2 px-1">
        <span>{formatLabel(chartData[0]?.label || '')}</span>
        <span>{formatLabel(chartData[chartData.length - 1]?.label || '')}</span>
      </div>
    </div>
  );
}
