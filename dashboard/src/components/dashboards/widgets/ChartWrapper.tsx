'use client';

import { useRef, useState, useEffect, ReactNode } from 'react';

interface ChartWrapperProps {
  children: (dimensions: { width: number; height: number }) => ReactNode;
  minHeight?: number;
  loading?: boolean;
}

/**
 * ChartWrapper provides explicit dimensions for Recharts ResponsiveContainer.
 *
 * Recharts' ResponsiveContainer requires its parent to have explicit width/height.
 * This component measures its container and provides those dimensions to children.
 */
export function ChartWrapper({ children, minHeight = 200, loading = false }: ChartWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateDimensions = () => {
      const rect = container.getBoundingClientRect();
      setDimensions({
        width: rect.width,
        height: Math.max(rect.height, minHeight),
      });
    };

    // Initial measurement
    updateDimensions();

    // Use ResizeObserver for responsive updates
    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [minHeight]);

  return (
    <div
      ref={containerRef}
      className="flex-grow w-full"
      style={{ minHeight }}
    >
      {loading || !dimensions ? (
        <div className="flex items-center justify-center h-full text-text-muted">
          <div className="animate-pulse">Loading chart...</div>
        </div>
      ) : dimensions.width > 0 && dimensions.height > 0 ? (
        children(dimensions)
      ) : null}
    </div>
  );
}
