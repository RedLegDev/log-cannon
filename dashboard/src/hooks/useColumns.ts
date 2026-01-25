'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export interface ColumnConfig {
  property: string
  label?: string
  width?: number
}

const STORAGE_KEY = 'log-cannon-columns'
const MAX_COLUMNS = 5
const URL_PARAM = 'columns'

function parseColumnsFromUrl(param: string | null): ColumnConfig[] | null {
  if (!param) return null
  const properties = param.split(',').filter(Boolean)
  if (properties.length === 0) return null
  return properties.slice(0, MAX_COLUMNS).map(property => ({ property }))
}

function parseColumnsFromStorage(): ColumnConfig[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, MAX_COLUMNS)
  } catch {
    return []
  }
}

function saveColumnsToStorage(columns: ColumnConfig[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(columns))
  } catch {
    // Ignore storage errors
  }
}

function columnsToUrlParam(columns: ColumnConfig[]): string {
  return columns.map(c => c.property).join(',')
}

export function useColumns() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [columns, setColumnsState] = useState<ColumnConfig[]>([])
  const [isInitialized, setIsInitialized] = useState(false)

  // Initialize columns from URL or localStorage
  useEffect(() => {
    const urlParam = searchParams.get(URL_PARAM)
    const fromUrl = parseColumnsFromUrl(urlParam)

    if (fromUrl) {
      setColumnsState(fromUrl)
      saveColumnsToStorage(fromUrl)
    } else {
      const fromStorage = parseColumnsFromStorage()
      setColumnsState(fromStorage)
    }
    setIsInitialized(true)
  }, [searchParams])

  // Update URL when columns change (after initialization)
  const updateUrl = useCallback((newColumns: ColumnConfig[]) => {
    const params = new URLSearchParams(searchParams.toString())
    if (newColumns.length > 0) {
      params.set(URL_PARAM, columnsToUrlParam(newColumns))
    } else {
      params.delete(URL_PARAM)
    }
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router, searchParams])

  const setColumns = useCallback((newColumns: ColumnConfig[]) => {
    const limited = newColumns.slice(0, MAX_COLUMNS)
    setColumnsState(limited)
    saveColumnsToStorage(limited)
    if (isInitialized) {
      updateUrl(limited)
    }
  }, [isInitialized, updateUrl])

  const addColumn = useCallback((property: string, label?: string) => {
    setColumnsState(current => {
      // Don't add if already exists
      if (current.some(c => c.property === property)) return current
      // Don't add if at max
      if (current.length >= MAX_COLUMNS) return current

      const newColumns = [...current, { property, label }]
      saveColumnsToStorage(newColumns)
      if (isInitialized) {
        updateUrl(newColumns)
      }
      return newColumns
    })
  }, [isInitialized, updateUrl])

  const removeColumn = useCallback((property: string) => {
    setColumnsState(current => {
      const newColumns = current.filter(c => c.property !== property)
      saveColumnsToStorage(newColumns)
      if (isInitialized) {
        updateUrl(newColumns)
      }
      return newColumns
    })
  }, [isInitialized, updateUrl])

  const toggleColumn = useCallback((property: string, label?: string) => {
    setColumnsState(current => {
      const exists = current.some(c => c.property === property)
      let newColumns: ColumnConfig[]

      if (exists) {
        newColumns = current.filter(c => c.property !== property)
      } else if (current.length < MAX_COLUMNS) {
        newColumns = [...current, { property, label }]
      } else {
        return current
      }

      saveColumnsToStorage(newColumns)
      if (isInitialized) {
        updateUrl(newColumns)
      }
      return newColumns
    })
  }, [isInitialized, updateUrl])

  const hasColumn = useCallback((property: string): boolean => {
    return columns.some(c => c.property === property)
  }, [columns])

  const reorderColumns = useCallback((fromIndex: number, toIndex: number) => {
    setColumnsState(current => {
      const newColumns = [...current]
      const [moved] = newColumns.splice(fromIndex, 1)
      newColumns.splice(toIndex, 0, moved)
      saveColumnsToStorage(newColumns)
      if (isInitialized) {
        updateUrl(newColumns)
      }
      return newColumns
    })
  }, [isInitialized, updateUrl])

  return {
    columns,
    setColumns,
    addColumn,
    removeColumn,
    toggleColumn,
    hasColumn,
    reorderColumns,
    maxColumns: MAX_COLUMNS,
    canAddMore: columns.length < MAX_COLUMNS,
  }
}
