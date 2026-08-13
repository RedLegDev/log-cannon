'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export interface ColumnConfig {
  property: string
  label?: string
  width?: number
}

const STORAGE_KEY = 'log-cannon-columns'
const STORAGE_EVENT = 'log-cannon-columns'
const MAX_COLUMNS = 5
const URL_PARAM = 'columns'

function parseColumnsFromUrl(param: string | null): ColumnConfig[] | null {
  if (!param) return null
  const properties = param.split(',').filter(Boolean)
  if (properties.length === 0) return null
  return properties.slice(0, MAX_COLUMNS).map(property => ({ property }))
}

function parseColumnsFromJson(raw: string | null): ColumnConfig[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, MAX_COLUMNS)
  } catch {
    return []
  }
}

function subscribeToStoredColumns(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange)
  window.addEventListener(STORAGE_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener(STORAGE_EVENT, onStoreChange)
  }
}

function getStoredColumnsSnapshot(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function saveColumnsToStorage(columns: ColumnConfig[]): void {
  if (typeof window === 'undefined') return
  try {
    const next = JSON.stringify(columns)
    if (localStorage.getItem(STORAGE_KEY) === next) return
    localStorage.setItem(STORAGE_KEY, next)
    window.dispatchEvent(new Event(STORAGE_EVENT))
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
  const urlParam = searchParams.get(URL_PARAM)
  const fromUrl = parseColumnsFromUrl(urlParam)
  const storedJson = useSyncExternalStore(
    subscribeToStoredColumns,
    getStoredColumnsSnapshot,
    () => null,
  )
  const columns = fromUrl ?? parseColumnsFromJson(storedJson)

  // Persist a shared URL's columns so the next visit without the param still has them.
  useEffect(() => {
    const parsed = parseColumnsFromUrl(urlParam)
    if (parsed) saveColumnsToStorage(parsed)
  }, [urlParam])

  const updateUrl = useCallback((newColumns: ColumnConfig[]) => {
    const params = new URLSearchParams(searchParams.toString())
    if (newColumns.length > 0) {
      params.set(URL_PARAM, columnsToUrlParam(newColumns))
    } else {
      params.delete(URL_PARAM)
    }
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router, searchParams])

  const commit = useCallback((newColumns: ColumnConfig[]) => {
    const limited = newColumns.slice(0, MAX_COLUMNS)
    saveColumnsToStorage(limited)
    updateUrl(limited)
  }, [updateUrl])

  const setColumns = useCallback((newColumns: ColumnConfig[]) => {
    commit(newColumns)
  }, [commit])

  const addColumn = useCallback((property: string, label?: string) => {
    if (columns.some(c => c.property === property)) return
    if (columns.length >= MAX_COLUMNS) return
    commit([...columns, { property, label }])
  }, [columns, commit])

  const removeColumn = useCallback((property: string) => {
    commit(columns.filter(c => c.property !== property))
  }, [columns, commit])

  const toggleColumn = useCallback((property: string, label?: string) => {
    const exists = columns.some(c => c.property === property)
    if (exists) {
      commit(columns.filter(c => c.property !== property))
    } else if (columns.length < MAX_COLUMNS) {
      commit([...columns, { property, label }])
    }
  }, [columns, commit])

  const hasColumn = useCallback((property: string): boolean => {
    return columns.some(c => c.property === property)
  }, [columns])

  const reorderColumns = useCallback((fromIndex: number, toIndex: number) => {
    const next = [...columns]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    commit(next)
  }, [columns, commit])

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
