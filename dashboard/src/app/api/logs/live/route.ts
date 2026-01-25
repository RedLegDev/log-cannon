import { NextRequest, NextResponse } from 'next/server'

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123'

export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get('since')

  let sql = `
    SELECT
      toString(id) as id,
      toString(timestamp) as timestamp,
      level,
      message,
      source,
      exception,
      properties
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 5 MINUTE
  `

  if (since) {
    sql += ` AND timestamp > parseDateTimeBestEffort('${since}')`
  }

  sql += ` ORDER BY timestamp DESC LIMIT 100 FORMAT JSON`

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
