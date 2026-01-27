# LLM Dashboard Documentation Design

## Overview

Provides LLM-friendly documentation at `/llms.txt` to help AI assistants create dashboard configurations for Log Cannon.

## Decisions

1. **Scope**: Dashboard schema + data context (database schema, query patterns)
2. **Delivery**: Dynamic route at `/llms.txt` with live context
3. **Dynamic content**: Active sources, log levels, property keys, existing endpoints, example dashboards
4. **Instruction style**: Schema-focused (no API instructions)

## Implementation

Route: `dashboard/src/app/llms.txt/route.ts`

### Static Content
- Dashboard JSON schema
- Widget types and configuration options
- Data model (events table schema)
- Query patterns and ClickHouse JSON functions
- Complete example dashboard

### Dynamic Content (queried at request time)
- Active sources (last 24 hours)
- Log levels in use
- Discovered property keys from recent logs
- Existing endpoints with SQL
- Configured dashboards as examples

### Caching
- `Cache-Control: public, max-age=60` (1 minute)

## Usage

Point an LLM at `http://your-instance/llms.txt` and ask it to create dashboards based on the documentation and available data context.
