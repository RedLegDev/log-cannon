import { NextRequest, NextResponse } from 'next/server'

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123'

function escapeString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function isNumericValue(value: string): boolean {
  return !isNaN(Number(value)) && value.trim() !== ''
}

// Handles both nested JSON objects and JSON strings that contain JSON
function buildJsonExtractSql(columnName: string, path: string, valueType: 'string' | 'number'): string {
  const parts = path.split('.')
  if (parts.length === 1) {
    return valueType === 'number'
      ? `JSONExtractFloat(${columnName}, '${escapeString(parts[0])}')`
      : `JSONExtractString(${columnName}, '${escapeString(parts[0])}')`
  }

  // For nested paths, try both approaches:
  // 1. Direct nested extraction (for actual nested objects)
  // 2. Extract first key as string, then parse as JSON (for JSON strings)
  const pathArgs = parts.map(p => `'${escapeString(p)}'`).join(', ')
  const firstKey = `'${escapeString(parts[0])}'`
  const restPathArgs = parts.slice(1).map(p => `'${escapeString(p)}'`).join(', ')

  if (valueType === 'number') {
    return `coalesce(
      nullIf(JSONExtractFloat(${columnName}, ${pathArgs}), 0),
      JSONExtractFloat(JSONExtractString(${columnName}, ${firstKey}), ${restPathArgs})
    )`
  } else {
    return `coalesce(
      nullIf(JSONExtractString(${columnName}, ${pathArgs}), ''),
      JSONExtractString(JSONExtractString(${columnName}, ${firstKey}), ${restPathArgs})
    )`
  }
}

type PropertyOperator = '=' | '!=' | '>' | '>=' | '<' | '<='

function parseOperatorFromValue(rawValue: string): { operator: PropertyOperator; value: string } {
  if (rawValue.startsWith('>=')) return { operator: '>=', value: rawValue.slice(2) }
  if (rawValue.startsWith('<=')) return { operator: '<=', value: rawValue.slice(2) }
  if (rawValue.startsWith('!=')) return { operator: '!=', value: rawValue.slice(2) }
  if (rawValue.startsWith('>')) return { operator: '>', value: rawValue.slice(1) }
  if (rawValue.startsWith('<')) return { operator: '<', value: rawValue.slice(1) }
  return { operator: '=', value: rawValue }
}

function getIntervalFromPreset(preset: string): string {
  switch (preset) {
    case '30m': return '30 MINUTE'
    case '1h': return '1 HOUR'
    case '4h': return '4 HOUR'
    case '6h': return '6 HOUR'
    case '1d': return '24 HOUR'
    case 'today': return '24 HOUR'
    case 'week': return '7 DAY'
    case 'all': return '365 DAY'
    case 'now': return '5 MINUTE'
    default: return '24 HOUR'
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const since = searchParams.get('since')
  const source = searchParams.get('source')
  const level = searchParams.get('level')
  const search = searchParams.get('search')
  const time = searchParams.get('time')
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  // Parse property filters (prop.key=value format)
  const propertyFilters: { key: string; value: string; operator: PropertyOperator }[] = []
  searchParams.forEach((value, key) => {
    if (key.startsWith('prop.')) {
      const propKey = key.slice(5)
      const { operator, value: parsedValue } = parseOperatorFromValue(value)
      propertyFilters.push({ key: propKey, value: parsedValue, operator })
    }
  })

  const conditions: string[] = []

  // Time filtering - support absolute range or preset
  if (from) {
    conditions.push(`e.timestamp >= parseDateTimeBestEffort('${escapeString(from)}')`)
  }
  if (to) {
    conditions.push(`e.timestamp <= parseDateTimeBestEffort('${escapeString(to)}')`)
  }
  if (!from && !to) {
    const interval = getIntervalFromPreset(time || '1d')
    conditions.push(`e.timestamp > now() - INTERVAL ${interval}`)
  }

  // For live tailing, also filter by since timestamp
  if (since) {
    conditions.push(`e.timestamp > parseDateTimeBestEffort('${escapeString(since)}')`)
  }

  if (source) {
    conditions.push(`e.source = '${escapeString(source)}'`)
  }

  if (level) {
    conditions.push(`e.level = '${escapeString(level)}'`)
  }

  if (search) {
    conditions.push(`e.message LIKE '%${escapeString(search)}%'`)
  }

  for (const filter of propertyFilters) {
    const isNumeric = isNumericValue(filter.value)
    const jsonExtract = buildJsonExtractSql('e.properties', filter.key, isNumeric ? 'number' : 'string')
    const escapedValue = escapeString(filter.value)

    if (isNumeric) {
      conditions.push(`${jsonExtract} ${filter.operator} ${escapedValue}`)
    } else {
      const op = filter.operator === '!=' ? '!=' : '='
      conditions.push(`${jsonExtract} ${op} '${escapedValue}'`)
    }
  }

  const sql = `
    SELECT
      toString(e.id) as id,
      formatDateTime(e.timestamp, '%Y-%m-%d %H:%i:%S') as timestamp,
      e.level,
      e.message,
      e.source,
      e.exception,
      e.properties
    FROM logs.events e
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.timestamp DESC
    LIMIT 100
    FORMAT JSON`

  try {
    const response = await fetch(CLICKHOUSE_URL, {
      method: 'POST',
      body: sql,
      headers: { 'Content-Type': 'text/plain' },
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json({ error: errorText }, { status: 500 })
    }

    const result = await response.json()
    return NextResponse.json({ logs: result.data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
