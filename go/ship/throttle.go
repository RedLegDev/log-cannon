package ship

import (
	"sync"
	"time"
)

// Throttle allows at most one true result per interval. Safe for concurrent
// use. A zero or negative interval means every call returns true.
type Throttle struct {
	interval time.Duration
	mu       sync.Mutex
	last     time.Time
}

func NewThrottle(interval time.Duration) *Throttle {
	return &Throttle{interval: interval}
}

// Allow reports whether an emission should proceed and records the attempt
// time when it does.
func (t *Throttle) Allow() bool {
	if t == nil || t.interval <= 0 {
		return true
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.last.IsZero() && now.Sub(t.last) < t.interval {
		return false
	}
	t.last = now
	return true
}
