# Show as Column Feature Design

## Overview

Add the ability to promote log properties to visible columns in the log list, matching Seq's "Show as column" feature. Columns appear between source and message in the collapsed log row view.

## Data Model

```typescript
interface ColumnConfig {
  property: string;    // Property key (e.g., "UserId", "CorrelationId")
  label?: string;      // Optional display label (defaults to property name)
  width?: number;      // Optional width in pixels (default: 120)
}
```

### Persistence

- **Local storage key:** `log-cannon-columns` storing `ColumnConfig[]`
- **URL param:** `columns=UserId,CorrelationId,RequestPath` (comma-separated property names)
- URL param overrides local storage when present
- Column changes update both local storage and URL
- Maximum 5 columns to prevent overcrowding

## Column Display

### Layout (collapsed row)

```
[timestamp] [level badge] [source] [col1] [col2] [col3] ... [message]
```

### Styling

- Visual style matches existing source badge
- Background: subtle dark chip
- Text: monospace, truncated at ~15 characters with ellipsis
- Tooltip on hover: full value and property name
- Missing values: muted `—` placeholder

### Responsive Behavior

- Columns hide first on narrow screens
- Priority: timestamp → level → source → message → columns

## Interactions

### Context Menu (property values in expanded details)

- Triggered by right-click or `⋮` menu icon on hover
- Options:
  - "Show as column" / "Remove column" (toggle)
  - Existing filter options remain

### Header Column Picker

- `+` or columns icon in log list header
- Dropdown shows:
  - Active columns with `×` remove button
  - "Add column" input with autocomplete
  - Empty state guidance text

### URL Sync

- Column changes update URL without page reload
- Shareable via address bar copy

## Implementation

### Files to Modify

1. `dashboard/src/app/page.tsx` - Column state management, URL/localStorage reading
2. `dashboard/src/components/LogRow.tsx` - Column chips, context menu on properties
3. `dashboard/src/components/LogList.tsx` - Header column picker button

### New Files

1. `dashboard/src/hooks/useColumns.ts` - Column state hook, localStorage/URL sync
2. `dashboard/src/components/ColumnPicker.tsx` - Header dropdown component

### Implementation Order

1. `useColumns` hook (state foundation)
2. Column display in `LogRow`
3. Context menu on properties
4. Header `ColumnPicker`
5. URL sync

### Backend

No backend changes required - purely frontend display preference.
