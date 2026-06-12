package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/keystore"
	ethcommon "github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

func parsePrivateKeyBytes(payload []byte) ([]byte, error) {
	trimmedBytes := []byte(strings.TrimSpace(string(payload)))
	if len(trimmedBytes) == 32 {
		out := make([]byte, len(trimmedBytes))
		copy(out, trimmedBytes)
		return out, nil
	}

	trimmed := strings.TrimSpace(string(trimmedBytes))
	if trimmed == "" {
		return nil, fmt.Errorf("exported payload is empty")
	}

	if fromJSON, ok := tryExtractPrivateKeyFromJSON(trimmed); ok {
		return fromJSON, nil
	}

	if decoded, ok := decodeHexPrivateKey(trimmed); ok {
		return decoded, nil
	}

	if decoded, ok := decodeBase64PrivateKey(trimmed); ok {
		return decoded, nil
	}

	return nil, fmt.Errorf("unsupported private key payload format")
}

func tryExtractPrivateKeyFromJSON(payload string) ([]byte, bool) {
	parsed := map[string]interface{}{}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		return nil, false
	}

	for _, key := range []string{"privateKey", "private_key", "key"} {
		value, ok := parsed[key]
		if !ok {
			continue
		}
		keyString, ok := value.(string)
		if !ok {
			continue
		}
		if decoded, ok := decodeHexPrivateKey(strings.TrimSpace(keyString)); ok {
			return decoded, true
		}
	}
	return nil, false
}

func decodeHexPrivateKey(payload string) ([]byte, bool) {
	hexPayload := strings.TrimPrefix(payload, "0x")
	if len(hexPayload) != 64 {
		return nil, false
	}

	decoded, err := hex.DecodeString(hexPayload)
	if err != nil {
		return nil, false
	}
	if len(decoded) != 32 {
		return nil, false
	}

	return decoded, true
}

func decodeBase64PrivateKey(payload string) ([]byte, bool) {
	decode := func(raw []byte, err error) ([]byte, bool) {
		if err != nil || len(raw) != 32 {
			return nil, false
		}
		return raw, true
	}

	if decoded, ok := decode(base64.StdEncoding.DecodeString(payload)); ok {
		return decoded, true
	}
	if decoded, ok := decode(base64.RawStdEncoding.DecodeString(payload)); ok {
		return decoded, true
	}
	if decoded, ok := decode(base64.URLEncoding.DecodeString(payload)); ok {
		return decoded, true
	}
	if decoded, ok := decode(base64.RawURLEncoding.DecodeString(payload)); ok {
		return decoded, true
	}
	return nil, false
}

func writeKeystoreAndPassword(cfg bootstrapConfig, expectedAddress ethcommon.Address, privateKeyBytes []byte) error {
	keystoreDir := filepath.Join(cfg.SignerDataDir, "keystore")
	if err := os.MkdirAll(keystoreDir, 0o700); err != nil {
		return fmt.Errorf("create keystore directory: %w", err)
	}

	entries, err := os.ReadDir(keystoreDir)
	if err != nil {
		return fmt.Errorf("read keystore directory: %w", err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(keystoreDir, entry.Name())); err != nil {
			return fmt.Errorf("clear existing keystore entries: %w", err)
		}
	}

	privateKey, err := ethcrypto.ToECDSA(privateKeyBytes)
	if err != nil {
		return fmt.Errorf("decode secp256k1 private key: %w", err)
	}

	store := keystore.NewKeyStore(keystoreDir, keystore.StandardScryptN, keystore.StandardScryptP)
	account, err := store.ImportECDSA(privateKey, cfg.SignerKeystorePassword)
	if err != nil {
		return fmt.Errorf("write UTC keystore: %w", err)
	}

	if account.Address != expectedAddress {
		return fmt.Errorf("exported private key resolves to %s but expected %s", account.Address.Hex(), expectedAddress.Hex())
	}

	passwordPath := filepath.Join(cfg.SignerDataDir, ".eth-password")
	if err := os.WriteFile(passwordPath, []byte(cfg.SignerKeystorePassword), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", passwordPath, err)
	}

	return nil
}

func writeResolvedAddress(outputPath string, address ethcommon.Address) error {
	parent := filepath.Dir(outputPath)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", parent, err)
	}
	if err := os.WriteFile(outputPath, []byte(address.Hex()), 0o600); err != nil {
		return fmt.Errorf("write resolved signer address: %w", err)
	}
	return nil
}
