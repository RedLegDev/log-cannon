package main

import (
	"fmt"

	"github.com/twmb/murmur3"
)

// computeEventType returns a MurmurHash3 32-bit hash formatted as "0x" followed
// by 8 lowercase hex digits. Matches the ingest-api implementation exactly.
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
