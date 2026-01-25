'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { X, Filter } from 'lucide-react'

interface PropertyFilter {
  key: string
  value: string
  exclude: boolean
}

function parsePropertyFilters(searchParams: URLSearchParams): PropertyFilter[] {
  const filters: PropertyFilter[] = []

  searchParams.forEach((value, key) => {
    if (key.startsWith('prop.')) {
      const exclude = key.endsWith('!')
      const propKey = exclude
        ? key.slice(5, -1)  // Remove 'prop.' and '!'
        : key.slice(5)      // Remove 'prop.'

      filters.push({ key: propKey, value, exclude })
    }
  })

  return filters
}

export function FilterBar() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const filters = parsePropertyFilters(searchParams)

  if (filters.length === 0) return null

  const removeFilter = (filter: PropertyFilter) => {
    const params = new URLSearchParams(searchParams.toString())
    const paramKey = filter.exclude ? `prop.${filter.key}!` : `prop.${filter.key}`
    params.delete(paramKey)
    router.push(`?${params.toString()}`)
  }

  const clearAllFilters = () => {
    const params = new URLSearchParams(searchParams.toString())
    // Remove all prop.* params
    const keysToDelete: string[] = []
    params.forEach((_, key) => {
      if (key.startsWith('prop.')) {
        keysToDelete.push(key)
      }
    })
    keysToDelete.forEach(key => params.delete(key))
    router.push(`?${params.toString()}`)
  }

  return (
    <div className="mb-4 p-3 bg-cannon-charcoal rounded-lg border border-cannon-graphite">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-text-secondary text-sm">
          <Filter size={14} />
          <span>Active Filters:</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {filters.map((filter, idx) => (
            <span
              key={`${filter.key}-${filter.value}-${idx}`}
              className={`
                inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-mono
                transition-all duration-200 group
                ${filter.exclude
                  ? 'bg-cannon-critical/20 text-cannon-critical border border-cannon-critical/30 hover:border-cannon-critical/50'
                  : 'bg-cannon-fire/20 text-cannon-ember border border-cannon-fire/30 hover:border-cannon-fire/50'
                }
              `}
            >
              <span className="font-semibold">{filter.key}</span>
              <span className="text-text-muted">{filter.exclude ? '!=' : '='}</span>
              <span className="text-text-code">{filter.value}</span>
              <button
                onClick={() => removeFilter(filter)}
                className="ml-1 p-0.5 rounded hover:bg-white/10 transition-colors"
                title="Remove filter"
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        {filters.length > 1 && (
          <button
            onClick={clearAllFilters}
            className="text-text-muted hover:text-cannon-fire text-sm font-medium transition-colors flex items-center gap-1"
          >
            <X size={14} />
            Clear all
          </button>
        )}
      </div>
    </div>
  )
}
