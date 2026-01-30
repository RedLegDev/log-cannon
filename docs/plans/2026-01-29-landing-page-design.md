# Landing Page Design

## Overview

Replace the current default landing experience (log explorer at `/`) with a dedicated dashboard that surfaces system health, activity metrics, and quick navigation. The log explorer moves to `/logs`.

## Design Decisions

- **Balanced focus:** Equal weight on health, activity, and navigation
- **Alert visibility:** Active alerts shown prominently; quiet when all clear
- **Time windows:** Both real-time (per minute) and 24h totals
- **Services:** Top 5 by error count, clickable to filter log explorer
- **Quick access:** Recent saved queries and dashboards
- **Layout:** Alert banner at top, then responsive card grid

## Page Structure

### 1. Alert Status Banner (Top, Full Width)

**When alerts are firing:**
- Red/orange banner with warning icon
- "2 alerts firing" with alert names as clickable pills
- Shows time since triggered (e.g., "error-spike · 5m ago")
- "View all alerts →" link

**When all clear:**
- Subtle green/gray: "✓ All systems healthy · 5 alerts configured"
- Or omit entirely to reduce noise

**When no alerts configured:**
- "No alerts configured · Set up alerts →"

### 2. Metrics Cards (Row of 4, 2x2 on Mobile)

| Card | Primary | Secondary |
|------|---------|-----------|
| Ingestion Rate | "1,247/min" | Sparkline (60 min) + trend "↑ 12%" |
| Today's Volume | "2.4M logs" | "18.2K errors (0.76%)" |
| Active Services | "12" | "3 with elevated errors" (clickable) |
| Error Rate | "0.8%" | Color-coded + sparkline |

**Error rate thresholds:**
- Green: <1%
- Yellow: 1-5%
- Red: >5%

### 3. Top Services Section

Card with header "Services" and "View all →" link.

Table showing top 5 services by error count (24h):

| Service | Logs (24h) | Errors | Error Rate |
|---------|------------|--------|------------|
| api-gateway | 842K | 3,241 | 0.38% |
| payment-service | 156K | 1,892 | 1.21% |
| ... | ... | ... | ... |

**Behavior:**
- Entire row clickable → `/logs?source={service}`
- Error rate column color-coded
- "View all →" → `/services`

### 4. Quick Access Section (Two Side-by-Side Cards)

**Saved Queries Card:**
- Header: "Saved Queries" + "View all →"
- 3-4 most recent queries, clickable to run
- Empty: "No saved queries yet · Save a query from Log Explorer"

**Dashboards Card:**
- Header: "Dashboards" + "View all →"
- 3-4 dashboards, clickable to open
- Empty: "No dashboards yet · Create a dashboard →"

## Routing Changes

| Current | New |
|---------|-----|
| `/` → Log Explorer | `/` → Landing Page (new) |
| — | `/logs` → Log Explorer |

Update navigation links accordingly.

## Services Page Update

Make service names in `/services` table clickable:
- Link to `/logs?source={service-name}`
- Consistent with landing page behavior

## Data Requirements

**New queries needed:**
- Logs per minute (current rate)
- Logs per minute over last 60 min (for sparklines)
- Error rate over last 60 min (for sparkline)
- Trend comparison (current hour vs previous hour)
- Currently firing alerts

**Existing queries (reuse):**
- 24h totals (logs, errors, error rate)
- Services with stats
- Saved queries list
- Dashboards list

## Verification

1. Landing page loads with all sections populated
2. Alert banner reflects actual alert state
3. Metrics match values shown on services page
4. Clicking service navigates to `/logs?source={name}`
5. Clicking saved query runs that query
6. Clicking dashboard opens that dashboard
7. Log explorer accessible at `/logs`
8. All existing `/` links still work (redirect or update)
