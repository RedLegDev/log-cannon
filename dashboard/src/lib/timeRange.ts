export type RelativeTimePreset =
  | '30m'
  | '1h'
  | '4h'
  | '6h'
  | '1d'
  | 'today'
  | 'week'
  | 'all'
  | 'now';

export interface TimeRange {
  type: 'relative' | 'absolute';
  preset?: RelativeTimePreset;
  from?: Date;
  to?: Date;
}

export interface TimeRangeBounds {
  start: Date | null;
  end: Date | null;
}

export const TIME_PRESETS: { value: RelativeTimePreset; label: string }[] = [
  { value: '30m', label: 'Last 30m' },
  { value: '1h', label: 'Last 1h' },
  { value: '4h', label: 'Last 4h' },
  { value: '6h', label: 'Last 6h' },
  { value: '1d', label: 'Last 1d' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'all', label: 'All time' },
  { value: 'now', label: 'From now' },
];

export function resolveTimeRange(range: TimeRange): TimeRangeBounds {
  const now = new Date();

  if (range.type === 'absolute') {
    return { start: range.from || null, end: range.to || null };
  }

  switch (range.preset) {
    case '30m':
      return { start: new Date(now.getTime() - 30 * 60 * 1000), end: null };
    case '1h':
      return { start: new Date(now.getTime() - 60 * 60 * 1000), end: null };
    case '4h':
      return { start: new Date(now.getTime() - 4 * 60 * 60 * 1000), end: null };
    case '6h':
      return { start: new Date(now.getTime() - 6 * 60 * 60 * 1000), end: null };
    case '1d':
      return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: null };
    case 'today': {
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      return { start: today, end: null };
    }
    case 'week': {
      const monday = new Date(now);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      return { start: monday, end: null };
    }
    case 'all':
      return { start: null, end: null };
    case 'now':
      return { start: now, end: null };
    default:
      return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: null };
  }
}

export function parseTimeRangeFromParams(params: URLSearchParams): TimeRange {
  const from = params.get('from');
  const to = params.get('to');

  if (from || to) {
    return {
      type: 'absolute',
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    };
  }

  const time = params.get('time') as RelativeTimePreset | null;
  return {
    type: 'relative',
    preset: time || '1d',
  };
}

export function timeRangeToParams(range: TimeRange): URLSearchParams {
  const params = new URLSearchParams();

  if (range.type === 'absolute') {
    if (range.from) params.set('from', range.from.toISOString());
    if (range.to) params.set('to', range.to.toISOString());
  } else if (range.preset && range.preset !== '1d') {
    params.set('time', range.preset);
  }

  return params;
}

export function getShiftDuration(range: TimeRange): number {
  if (range.type === 'absolute' && range.from && range.to) {
    return range.to.getTime() - range.from.getTime();
  }

  switch (range.preset) {
    case '30m':
      return 30 * 60 * 1000;
    case '1h':
      return 60 * 60 * 1000;
    case '4h':
      return 4 * 60 * 60 * 1000;
    case '6h':
      return 6 * 60 * 60 * 1000;
    case '1d':
      return 24 * 60 * 60 * 1000;
    case 'today':
      return 24 * 60 * 60 * 1000;
    case 'week':
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

export function shiftTimeRange(
  range: TimeRange,
  direction: 'forward' | 'backward'
): TimeRange {
  const bounds = resolveTimeRange(range);
  const duration = getShiftDuration(range);
  const shift = direction === 'forward' ? duration : -duration;

  const now = new Date();
  const currentEnd = bounds.end || now;
  const currentStart = bounds.start || new Date(currentEnd.getTime() - duration);

  const newEnd = new Date(currentEnd.getTime() + shift);
  const newStart = new Date(currentStart.getTime() + shift);

  if (newEnd > now) {
    return range;
  }

  return {
    type: 'absolute',
    from: newStart,
    to: newEnd,
  };
}

export function formatTimeRangeDisplay(range: TimeRange): string {
  if (range.type === 'relative') {
    const preset = TIME_PRESETS.find((p) => p.value === range.preset);
    return preset?.label || 'Last 1d';
  }

  const formatDate = (d: Date) => {
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (range.from && range.to) {
    return `${formatDate(range.from)} - ${formatDate(range.to)}`;
  }
  if (range.from) {
    return `From ${formatDate(range.from)}`;
  }
  if (range.to) {
    return `Until ${formatDate(range.to)}`;
  }
  return 'Custom range';
}

export function formatDateForInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60000;
  const local = new Date(date.getTime() - offset);
  return local.toISOString().slice(0, 16);
}
