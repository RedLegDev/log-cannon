'use client';

import { useState, useMemo } from 'react';
import { Widget } from '@/lib/clickhouse';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface TableWidgetProps {
  data: unknown[];
  widget: Widget;
}

export function TableWidget({ data, widget }: TableWidgetProps) {
  const config = widget.visualization;
  const [sortColumn, setSortColumn] = useState<string | null>(config?.sortBy || null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Get columns from config or from first row
  const columns = useMemo(() => {
    if (config?.columns && config.columns.length > 0) {
      return config.columns;
    }
    // Extract columns from first row
    if (data.length > 0) {
      return Object.keys(data[0] as Record<string, unknown>);
    }
    return [];
  }, [data, config?.columns]);

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortColumn) return data;

    return [...data].sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[sortColumn];
      const bVal = (b as Record<string, unknown>)[sortColumn];

      // Handle null/undefined
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      // Compare values
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }

      const aStr = String(aVal);
      const bStr = String(bVal);
      const comparison = aStr.localeCompare(bStr);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [data, sortColumn, sortDirection]);

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      // Toggle direction
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  if (data.length === 0) {
    return (
      <div className="flex-grow flex items-center justify-center text-text-muted text-sm">
        No data available
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-bg-primary border-b border-border-subtle">
          <tr>
            {columns.map(column => (
              <th
                key={column}
                className="px-3 py-2 text-left font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
                onClick={() => handleSort(column)}
              >
                <div className="flex items-center gap-1">
                  <span>{column}</span>
                  {sortColumn === column && (
                    sortDirection === 'asc'
                      ? <ChevronUp className="w-3 h-3" />
                      : <ChevronDown className="w-3 h-3" />
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className="border-b border-border-subtle hover:bg-bg-secondary transition-colors"
            >
              {columns.map(column => {
                const value = (row as Record<string, unknown>)[column];
                return (
                  <td key={column} className="px-3 py-2 text-text-primary">
                    {value === null || value === undefined
                      ? <span className="text-text-muted">-</span>
                      : String(value)
                    }
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
