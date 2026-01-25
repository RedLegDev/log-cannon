import { NextRequest, NextResponse } from 'next/server'

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123'

export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get('since')

  let sql = `
    SELECT
      toString(e.id) as id,
      formatDateTime(e.timestamp, '%Y-%m-%d %H:%i:%S') as timestamp,
      e.level,
      e.message,
      e.source,
      e.exception,
      e.properties
    FROM logs.events e
    WHERE e.timestamp > now() - INTERVAL 5 MINUTE
  `

  if (since) {
    sql += ` AND e.timestamp > parseDateTimeBestEffort('${since}')`
  }

  sql += ` ORDER BY e.timestamp DESC LIMIT 100 FORMAT JSON`

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
