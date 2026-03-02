'use client'

import { useState } from 'react'
import { X, Calendar } from 'lucide-react'
import { TimeRange, formatDateForInput, resolveTimeRange } from '@/lib/timeRange'

interface TimeRangeCalendarProps {
  initialRange: TimeRange
  onApply: (range: TimeRange) => void
  onClose: () => void
}

export function TimeRangeCalendar({ initialRange, onApply, onClose }: TimeRangeCalendarProps) {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const bounds = resolveTimeRange(initialRange)

  const [fromDate, setFromDate] = useState(
    formatDateForInput(bounds.start || yesterday)
  )
  const [toDate, setToDate] = useState(
    formatDateForInput(bounds.end || now)
  )
  const [error, setError] = useState<string | null>(null)

  function handleApply() {
    const from = new Date(fromDate)
    const to = new Date(toDate)

    if (from >= to) {
      setError('Start time must be before end time')
      return
    }

    onApply({
      type: 'absolute',
      from,
      to,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-cannon-charcoal rounded-lg p-6 w-full max-w-md mx-4 border border-cannon-graphite shadow-cannon-lg animate-fade-in">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Calendar className="w-5 h-5 text-cannon-fire" />
            Custom Time Range
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-cannon-steel transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-2">From</label>
            <input
              type="datetime-local"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value)
                setError(null)
              }}
              className="input-cannon w-full"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-2">To</label>
            <input
              type="datetime-local"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value)
                setError(null)
              }}
              className="input-cannon w-full"
            />
          </div>

          {error && (
            <p className="text-sm text-cannon-critical">{error}</p>
          )}
        </div>

        <div className="flex gap-3 mt-6 justify-end">
          <button type="button" onClick={onClose} className="btn-cannon-secondary">
            Cancel
          </button>
          <button type="button" onClick={handleApply} className="btn-cannon">
            Apply Range
          </button>
        </div>
      </div>
    </div>
  )
}
