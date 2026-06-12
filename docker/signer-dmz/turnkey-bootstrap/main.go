package main

import (
	"fmt"
	"os"
	"strings"

	ethcommon "github.com/ethereum/go-ethereum/common"
)

const (
	defaultTurnkeyHost       = "api.turnkey.com"
	defaultWalletName        = "livepeer-remote-signer"
	defaultSignerDataDir     = "/data"
	defaultSignerAddressFile = "/run/signer-bootstrap/signer-eth-addr"
)

type bootstrapConfig struct {
	TurnkeyOrgID string

	TurnkeyAPIPublicKey  string
	TurnkeyAPIPrivateKey string
	TurnkeyAPIHost       string

	TurnkeyWalletName string
	WalletNameFromEnv bool

	SignerETHAddr ethcommon.Address
	HasSignerAddr bool

	SignerKeystorePassword string
	SignerDataDir          string
	SignerAddressOut       string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "signer-turnkey-bootstrap: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := readConfig()
	if err != nil {
		return err
	}

	client, err := newTurnkeyClient(cfg)
	if err != nil {
		return err
	}

	resolved, err := resolveSignerAccount(client, cfg)
	if err != nil {
		return err
	}

	exportedPrivKey, err := exportAndDecryptWalletAccount(client, cfg, resolved.Address)
	if err != nil {
		return err
	}
	defer zeroBytes(exportedPrivKey)

	if err := writeKeystoreAndPassword(cfg, resolved.Address, exportedPrivKey); err != nil {
		return err
	}

	if err := writeResolvedAddress(cfg.SignerAddressOut, resolved.Address); err != nil {
		return err
	}

	fmt.Printf("signer-turnkey-bootstrap: resolved signer address %s\n", resolved.Address.Hex())
	return nil
}

func readConfig() (bootstrapConfig, error) {
	orgID, err := requireEnv("TURNKEY_ORG_ID")
	if err != nil {
		return bootstrapConfig{}, err
	}
	apiPublicKey, err := requireEnv("TURNKEY_API_PUBLIC_KEY")
	if err != nil {
		return bootstrapConfig{}, err
	}
	apiPrivateKey, err := requireEnv("TURNKEY_API_PRIVATE_KEY")
	if err != nil {
		return bootstrapConfig{}, err
	}

	keystorePassword, ok := os.LookupEnv("SIGNER_ETH_KEYSTORE_PASSWORD")
	if !ok {
		return bootstrapConfig{}, fmt.Errorf("SIGNER_ETH_KEYSTORE_PASSWORD must be set (may be empty)")
	}

	walletName, walletNameFromEnv := os.LookupEnv("TURNKEY_WALLET_NAME")
	if !walletNameFromEnv {
		walletName = defaultWalletName
	}
	walletName = strings.TrimSpace(walletName)
	if walletName == "" {
		return bootstrapConfig{}, fmt.Errorf("TURNKEY_WALLET_NAME cannot be empty")
	}

	cfg := bootstrapConfig{
		TurnkeyOrgID: orgID,

		TurnkeyAPIPublicKey:  strings.TrimSpace(apiPublicKey),
		TurnkeyAPIPrivateKey: strings.TrimSpace(apiPrivateKey),
		TurnkeyAPIHost:       strings.TrimSpace(envOrDefault("TURNKEY_API_HOST", defaultTurnkeyHost)),

		TurnkeyWalletName: walletName,
		WalletNameFromEnv: walletNameFromEnv,

		SignerKeystorePassword: keystorePassword,
		SignerDataDir:          strings.TrimSpace(envOrDefault("SIGNER_DATADIR", defaultSignerDataDir)),
		SignerAddressOut:       strings.TrimSpace(envOrDefault("SIGNER_ADDRESS_OUT", defaultSignerAddressFile)),
	}

	if cfg.SignerDataDir == "" {
		return bootstrapConfig{}, fmt.Errorf("SIGNER_DATADIR cannot be empty")
	}
	if cfg.SignerAddressOut == "" {
		return bootstrapConfig{}, fmt.Errorf("SIGNER_ADDRESS_OUT cannot be empty")
	}

	addrStr := strings.TrimSpace(os.Getenv("SIGNER_ETH_ADDR"))
	if addrStr != "" {
		if !ethcommon.IsHexAddress(addrStr) {
			return bootstrapConfig{}, fmt.Errorf("SIGNER_ETH_ADDR is not a valid 0x address: %q", addrStr)
		}
		cfg.SignerETHAddr = ethcommon.HexToAddress(addrStr)
		cfg.HasSignerAddr = true
	}

	return cfg, nil
}

func requireEnv(name string) (string, error) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s must be set", name)
	}
	return strings.TrimSpace(value), nil
}

func envOrDefault(name string, fallback string) string {
	value, ok := os.LookupEnv(name)
	if !ok {
		return fallback
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

func zeroBytes(buf []byte) {
	for i := range buf {
		buf[i] = 0
	}
}
