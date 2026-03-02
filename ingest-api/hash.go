package main

import (
	"fmt"

	"github.com/twmb/murmur3"
)

// computeEventType returns a MurmurHash3 32-bit hash formatted as "0x" followed
// by 8 lowercase hex digits (e.g. "0x5432a8ff"). It hashes the messageTemplate
// if non-empty, otherwise falls back to the rendered message. Returns "" if both
// inputs are empty.
func computeEventType(messageTemplate, message string) string {
	input := messageTemplate
	if input == "" {
		input = message
	}
	if input == "" {
		return ""
	}
	h := murmur3.Sum32([]byte(input))
	return fmt.Sprintf("0x%08x", h)
}
