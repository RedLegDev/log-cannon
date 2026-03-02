package main

import (
	"strings"
	"testing"
)

func TestComputeEventType_TemplateProvided(t *testing.T) {
	result := computeEventType("User {UserId} logged in from {IP}", "User 42 logged in from 1.2.3.4")
	if result == "" {
		t.Fatal("expected non-empty result when template is provided")
	}
	// Should hash the template, not the message
	resultFromTemplate := computeEventType("User {UserId} logged in from {IP}", "different message")
	if result != resultFromTemplate {
		t.Errorf("expected same hash for same template regardless of message, got %s vs %s", result, resultFromTemplate)
	}
}

func TestComputeEventType_FallbackToMessage(t *testing.T) {
	result := computeEventType("", "some log message")
	if result == "" {
		t.Fatal("expected non-empty result when message is provided")
	}
	// Different message should produce different hash
	other := computeEventType("", "different log message")
	if result == other {
		t.Errorf("expected different hashes for different messages, both got %s", result)
	}
}

func TestComputeEventType_BothEmpty(t *testing.T) {
	result := computeEventType("", "")
	if result != "" {
		t.Errorf("expected empty string when both inputs are empty, got %s", result)
	}
}

func TestComputeEventType_Format(t *testing.T) {
	result := computeEventType("Hello {Name}", "")
	if !strings.HasPrefix(result, "0x") {
		t.Errorf("expected 0x prefix, got %s", result)
	}
	if len(result) != 10 {
		t.Errorf("expected length 10 (0x + 8 hex chars), got %d: %s", len(result), result)
	}
	// Verify all chars after 0x are hex digits
	for _, c := range result[2:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("expected lowercase hex digit, got %c in %s", c, result)
		}
	}
}

func TestComputeEventType_Deterministic(t *testing.T) {
	template := "Request {Method} {Path} completed in {Duration}ms"
	first := computeEventType(template, "")
	for i := 0; i < 100; i++ {
		if got := computeEventType(template, ""); got != first {
			t.Fatalf("non-deterministic: iteration %d got %s, expected %s", i, got, first)
		}
	}
}
