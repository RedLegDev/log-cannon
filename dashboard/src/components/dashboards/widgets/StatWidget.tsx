'use client';

import { Widget } from '@/lib/clickhouse';

interface StatWidgetProps {
  data: unknown[];
  widget: Widget;
}

function formatValue(value: number | string, format?: 'number' | 'percent' | 'duration'): string {
  if (typeof value === 'string') {
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    value = num;
  }

  switch (format) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'duration':
      // Assume milliseconds, convert to seconds
      if (value < 1000) {
        return `${value.toFixed(0)}ms`;
      } else if (value < 60000) {
        return `${(value / 1000).toFixed(1)}s`;
      } else {
        return `${(value / 60000).toFixed(1)}m`;
      }
    case 'number':
    default:
      // Format with commas for thousands
      return value.toLocaleString('en-US', {
        maximumFractionDigits: 2
      });
  }
}

export function StatWidget({ data, widget }: StatWidgetProps) {
  const config = widget.visualization;
  const valueField = config?.valueField || 'value';

  // Extract value from first row
  const row = data[0] as Record<string, unknown>;
  const rawValue = row?.[valueField];

  if (rawValue === undefined || rawValue === null) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No value found for field: {valueField}
      </div>
    );
  }

  const value = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue));
  const formattedValue = formatValue(value, config?.format);

  return (
    <div className="flex-grow flex flex-col items-center justify-center">
      <div className="text-4xl md:text-5xl font-bold text-cannon-fire font-mono">
        {formattedValue}
      </div>
      {config?.trend && (
        <div className="mt-2 text-sm text-text-muted">
          {/* Trend indicator could be added in future with historical data comparison */}
        </div>
      )}
    </div>
  );
}
