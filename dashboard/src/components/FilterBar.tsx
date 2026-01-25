'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'

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
    <div className="mb-4 flex items-center gap-2 flex-wrap">
      <span className="text-gray-400 text-sm">Filters:</span>
      {filters.map((filter, idx) => (
        <span
          key={`${filter.key}-${filter.value}-${idx}`}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-sm ${
            filter.exclude
              ? 'bg-red-900/50 text-red-300 border border-red-700'
              : 'bg-blue-900/50 text-blue-300 border border-blue-700'
          }`}
        >
          <span className="font-medium">{filter.key}</span>
          <span className="text-gray-400">{filter.exclude ? '!=' : '='}</span>
          <span>{filter.value}</span>
          <button
            onClick={() => removeFilter(filter)}
            className="ml-1 hover:text-white"
            title="Remove filter"
          >
            <X size={14} />
          </button>
        </span>
      ))}
      {filters.length > 1 && (
        <button
          onClick={clearAllFilters}
          className="text-gray-400 hover:text-white text-sm underline"
        >
          Clear all
        </button>
      )}
    </div>
  )
}
