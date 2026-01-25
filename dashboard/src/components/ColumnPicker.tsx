'use client'

import { useState, useRef, useEffect } from 'react'
import { Columns, X, Plus, GripVertical } from 'lucide-react'
import { ColumnConfig } from '@/hooks/useColumns'

interface ColumnPickerProps {
  columns: ColumnConfig[]
  onRemove: (property: string) => void
  onAdd: (property: string) => void
  recentProperties: string[]
  canAddMore: boolean
  maxColumns: number
}

export function ColumnPicker({
  columns,
  onRemove,
  onAdd,
  recentProperties,
  canAddMore,
  maxColumns,
}: ColumnPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  const handleAddColumn = (property: string) => {
    if (property.trim() && canAddMore) {
      onAdd(property.trim())
      setInputValue('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      handleAddColumn(inputValue)
    } else if (e.key === 'Escape') {
      setIsOpen(false)
    }
  }

  // Filter suggestions based on input
  const suggestions = recentProperties
    .filter(prop =>
      !columns.some(c => c.property === prop) &&
      prop.toLowerCase().includes(inputValue.toLowerCase())
    )
    .slice(0, 5)

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors
          ${columns.length > 0
            ? 'bg-cannon-steel text-text-primary hover:bg-cannon-graphite'
            : 'text-text-muted hover:text-text-secondary hover:bg-cannon-steel'
          }
        `}
        title="Manage columns"
      >
        <Columns size={16} />
        {columns.length > 0 && (
          <span className="text-xs bg-cannon-graphite px-1.5 py-0.5 rounded">
            {columns.length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-cannon-charcoal border border-cannon-graphite rounded-lg shadow-cannon z-50 overflow-hidden animate-slide-down">
          <div className="p-3 border-b border-cannon-graphite">
            <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              Columns ({columns.length}/{maxColumns})
            </div>

            {columns.length === 0 ? (
              <div className="text-text-muted text-sm py-2">
                No columns configured. Add properties below or click &quot;Show as column&quot; on any property.
              </div>
            ) : (
              <div className="space-y-1">
                {columns.map((col) => (
                  <div
                    key={col.property}
                    className="flex items-center gap-2 px-2 py-1.5 bg-cannon-steel rounded group"
                  >
                    <GripVertical size={14} className="text-text-muted opacity-0 group-hover:opacity-50 cursor-grab" />
                    <span className="flex-grow font-mono text-sm text-text-primary truncate">
                      {col.label || col.property}
                    </span>
                    <button
                      onClick={() => onRemove(col.property)}
                      className="p-1 text-text-muted hover:text-cannon-critical rounded transition-colors"
                      title={`Remove ${col.property} column`}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {canAddMore && (
            <div className="p-3">
              <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                Add Column
              </div>
              <div className="relative">
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Property name..."
                  className="input-cannon w-full text-sm pr-10"
                />
                <button
                  onClick={() => handleAddColumn(inputValue)}
                  disabled={!inputValue.trim()}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-cannon-tracer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Plus size={16} />
                </button>
              </div>

              {suggestions.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="text-xs text-text-muted">Suggestions:</div>
                  {suggestions.map((prop) => (
                    <button
                      key={prop}
                      onClick={() => handleAddColumn(prop)}
                      className="block w-full text-left px-2 py-1.5 text-sm font-mono text-text-secondary hover:text-text-primary hover:bg-cannon-steel rounded transition-colors truncate"
                    >
                      {prop}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
