'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Clock, ChevronLeft, ChevronRight, ChevronDown, Calendar } from 'lucide-react'
import {
  TimeRange,
  parseTimeRangeFromParams,
  timeRangeToParams,
  shiftTimeRange,
  formatTimeRangeDisplay,
  TIME_PRESETS,
} from '@/lib/timeRange'
import { TimeRangeCalendar } from './TimeRangeCalendar'

interface TimeRangeFilterProps {
  className?: string
}

export function TimeRangeFilter({ className }: TimeRangeFilterProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isOpen, setIsOpen] = useState(false)
  const [showCalendar, setShowCalendar] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const currentRange = parseTimeRangeFromParams(searchParams)

  const updateTimeRange = (range: TimeRange) => {
    const newParams = new URLSearchParams(searchParams.toString())

    // Remove existing time params
    newParams.delete('time')
    newParams.delete('from')
    newParams.delete('to')

    // Add new time params
    const timeParams = timeRangeToParams(range)
    timeParams.forEach((value, key) => newParams.set(key, value))

    router.push(`?${newParams.toString()}`)
    setIsOpen(false)
  }

  const handleShift = (direction: 'forward' | 'backward') => {
    const newRange = shiftTimeRange(currentRange, direction)
    updateTimeRange(newRange)
  }

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const canShiftForward = currentRange.type === 'absolute'

  return (
    <div className={`relative ${className || ''}`} ref={dropdownRef}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => handleShift('backward')}
          className="p-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-cannon-steel transition-colors"
          title="Earlier"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-cannon-charcoal border border-cannon-graphite hover:border-cannon-slate transition-colors text-sm min-w-[140px]"
        >
          <Clock className="w-4 h-4 text-cannon-fire" />
          <span className="text-text-primary font-medium truncate">
            {formatTimeRangeDisplay(currentRange)}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-text-muted transition-transform ml-auto ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>

        <button
          type="button"
          onClick={() => handleShift('forward')}
          disabled={!canShiftForward}
          className="p-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-cannon-steel transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Later"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-48 bg-cannon-charcoal border border-cannon-graphite rounded-lg shadow-cannon-lg z-50 py-1 animate-fade-in">
          {TIME_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => updateTimeRange({ type: 'relative', preset: preset.value })}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                currentRange.type === 'relative' && currentRange.preset === preset.value
                  ? 'bg-cannon-fire/20 text-cannon-ember'
                  : 'text-text-secondary hover:text-text-primary hover:bg-cannon-steel'
              }`}
            >
              {preset.label}
            </button>
          ))}

          <div className="border-t border-cannon-graphite my-1" />

          <button
            type="button"
            onClick={() => {
              setShowCalendar(true)
              setIsOpen(false)
            }}
            className="w-full text-left px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-cannon-steel flex items-center gap-2"
          >
            <Calendar className="w-4 h-4" />
            Custom...
          </button>
        </div>
      )}

      {showCalendar && (
        <TimeRangeCalendar
          initialRange={currentRange}
          onApply={(range) => {
            updateTimeRange(range)
            setShowCalendar(false)
          }}
          onClose={() => setShowCalendar(false)}
        />
      )}
    </div>
  )
}
