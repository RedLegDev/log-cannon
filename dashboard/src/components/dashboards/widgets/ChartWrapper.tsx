'use client';

import { useRef, useState, useEffect, ReactNode } from 'react';

interface ChartWrapperProps {
  children: (dimensions: { width: number; height: number }) => ReactNode;
  minHeight?: number;
}

/**
 * ChartWrapper provides explicit dimensions for Recharts ResponsiveContainer.
 * Uses ResizeObserver to measure the container and passes dimensions to children.
 */
export function ChartWrapper({ children, minHeight = 200 }: ChartWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateDimensions = () => {
      const rect = container.getBoundingClientRect();
      const width = rect.width;
      // Use minHeight as fallback if measured height is too small
      const height = rect.height > 50 ? rect.height : minHeight;

      if (width > 0 && height > 0) {
        setDimensions({ width, height });
        setIsReady(true);
      }
    };

    // Delay initial measurement to let flex layout settle
    const timeoutId = setTimeout(updateDimensions, 50);

    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
    };
  }, [minHeight]);

  return (
    <div
      ref={containerRef}
      className="flex-grow w-full h-full"
      style={{ minHeight }}
    >
      {!isReady ? (
        <div className="flex items-center justify-center h-full text-text-muted">
          <div className="animate-pulse">Loading chart...</div>
        </div>
      ) : (
        children(dimensions)
      )}
    </div>
  );
}
