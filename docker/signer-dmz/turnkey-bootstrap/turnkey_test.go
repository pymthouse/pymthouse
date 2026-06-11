package main

import (
	"testing"
)

func TestParseEthereumBIP44PathIndex(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		path     string
		expected int
		ok       bool
	}{
		{
			name:     "valid path",
			path:     "m/44'/60'/0'/0/7",
			expected: 7,
			ok:       true,
		},
		{
			name:     "invalid prefix",
			path:     "m/44'/60'/1'/0/0",
			expected: 0,
			ok:       false,
		},
		{
			name:     "invalid index",
			path:     "m/44'/60'/0'/0/x",
			expected: 0,
			ok:       false,
		},
	}

	for _, testCase := range tests {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, ok := parseEthereumBIP44PathIndex(testCase.path)
			if ok != testCase.ok {
				t.Fatalf("ok mismatch: got %v want %v", ok, testCase.ok)
			}
			if got != testCase.expected {
				t.Fatalf("index mismatch: got %d want %d", got, testCase.expected)
			}
		})
	}
}

func TestParsePrivateKeyBytes(t *testing.T) {
	t.Parallel()

	const keyHex = "0x4c0883a69102937d6234146f454bcc8f2f4de2d855f6be63b97d93f57a7d4b77"

	tests := []struct {
		name    string
		payload string
		ok      bool
	}{
		{
			name:    "plain hex",
			payload: keyHex,
			ok:      true,
		},
		{
			name:    "json key",
			payload: `{"privateKey":"` + keyHex + `"}`,
			ok:      true,
		},
		{
			name:    "invalid",
			payload: "not-a-private-key",
			ok:      false,
		},
	}

	for _, testCase := range tests {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			got, err := parsePrivateKeyBytes([]byte(testCase.payload))
			if testCase.ok && err != nil {
				t.Fatalf("expected success, got error: %v", err)
			}
			if !testCase.ok && err == nil {
				t.Fatalf("expected error, got success (%x)", got)
			}
			if testCase.ok && len(got) != 32 {
				t.Fatalf("expected 32-byte key, got %d bytes", len(got))
			}
		})
	}
}
