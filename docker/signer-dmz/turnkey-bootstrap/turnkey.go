package main

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	ethcommon "github.com/ethereum/go-ethereum/common"
	sdk "github.com/tkhq/go-sdk"
	turnkeyclient "github.com/tkhq/go-sdk/pkg/api/client"
	"github.com/tkhq/go-sdk/pkg/api/client/wallets"
	"github.com/tkhq/go-sdk/pkg/api/models"
	"github.com/tkhq/go-sdk/pkg/apikey"
	"github.com/tkhq/go-sdk/pkg/enclave_encrypt"
	"github.com/tkhq/go-sdk/pkg/encryptionkey"
	"github.com/tkhq/go-sdk/pkg/util"
)

const defaultEthereumDerivationPath = "m/44'/60'/0'/0/0"

type walletAccount struct {
	WalletID string
	Address  ethcommon.Address
	Path     string
}

func newTurnkeyClient(cfg bootstrapConfig) (*sdk.Client, error) {
	rawPrivateKey, signatureScheme, err := apikey.ExtractSignatureSchemeFromSuffixedPrivateKey(cfg.TurnkeyAPIPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("parse TURNKEY_API_PRIVATE_KEY: %w", err)
	}

	key, err := apikey.FromTurnkeyPrivateKey(rawPrivateKey, signatureScheme)
	if err != nil {
		return nil, fmt.Errorf("decode TURNKEY_API_PRIVATE_KEY: %w", err)
	}

	expectedPublic := strings.TrimPrefix(strings.TrimSpace(cfg.TurnkeyAPIPublicKey), "0x")
	actualPublic := strings.TrimPrefix(strings.TrimSpace(key.TkPublicKey), "0x")
	if !strings.EqualFold(expectedPublic, actualPublic) {
		return nil, fmt.Errorf("TURNKEY_API_PUBLIC_KEY does not match TURNKEY_API_PRIVATE_KEY")
	}

	key.PublicKey = key.TkPublicKey
	key.Organizations = []string{
		cfg.TurnkeyOrgID,
	}

	transportConfig, err := parseTurnkeyHost(cfg.TurnkeyAPIHost)
	if err != nil {
		return nil, err
	}

	client, err := sdk.New(
		sdk.WithAPIKey(key),
		sdk.WithTransportConfig(transportConfig),
	)
	if err != nil {
		return nil, fmt.Errorf("create turnkey sdk client: %w", err)
	}

	return client, nil
}

func parseTurnkeyHost(host string) (turnkeyclient.TransportConfig, error) {
	cfg := turnkeyclient.DefaultTransportConfig()

	if strings.Contains(host, "://") {
		parsed, err := url.Parse(host)
		if err != nil {
			return turnkeyclient.TransportConfig{}, fmt.Errorf("parse TURNKEY_API_HOST: %w", err)
		}
		if parsed.Host == "" || parsed.Scheme == "" {
			return turnkeyclient.TransportConfig{}, fmt.Errorf("TURNKEY_API_HOST must include host and scheme when using a URL: %q", host)
		}
		cfg.Host = parsed.Host
		cfg.Schemes = []string{parsed.Scheme}
		if parsed.Path != "" && parsed.Path != "/" {
			cfg.BasePath = parsed.Path
		}
		return *cfg, nil
	}

	cfg.Host = host
	cfg.Schemes = []string{"https"}
	return *cfg, nil
}

func resolveSignerAccount(client *sdk.Client, cfg bootstrapConfig) (walletAccount, error) {
	walletID, err := resolveWalletID(client, cfg)
	if err != nil {
		return walletAccount{}, err
	}

	accounts, err := listTurnkeyEthereumAccounts(client, cfg.TurnkeyOrgID, walletID)
	if err != nil {
		return walletAccount{}, err
	}

	if cfg.HasSignerAddr {
		for _, account := range accounts {
			if account.Address == cfg.SignerETHAddr {
				return account, nil
			}
		}
		return walletAccount{}, fmt.Errorf("SIGNER_ETH_ADDR %s was not found in wallet %s", cfg.SignerETHAddr.Hex(), cfg.TurnkeyWalletName)
	}

	if len(accounts) > 0 {
		return accounts[0], nil
	}

	address, err := createTurnkeyWalletAccount(client, cfg.TurnkeyOrgID, walletID)
	if err != nil {
		return walletAccount{}, err
	}
	return walletAccount{
		WalletID: walletID,
		Address:  address,
		Path:     "",
	}, nil
}

func findWalletIDByName(wallets []*models.Wallet, walletName string) (string, error) {
	var walletID string
	for _, wallet := range wallets {
		if wallet == nil || wallet.WalletName == nil || wallet.WalletID == nil {
			continue
		}
		if *wallet.WalletName != walletName {
			continue
		}
		if walletID != "" {
			return "", fmt.Errorf("multiple wallets matched TURNKEY_WALLET_NAME=%q", walletName)
		}
		walletID = *wallet.WalletID
	}
	return walletID, nil
}

func resolveWalletID(client *sdk.Client, cfg bootstrapConfig) (string, error) {
	orgID := cfg.TurnkeyOrgID
	params := wallets.NewGetWalletsParams().WithBody(&models.GetWalletsRequest{
		OrganizationID: &orgID,
	})
	resp, err := client.V0().Wallets.GetWallets(params, client.Authenticator)
	if err != nil {
		return "", fmt.Errorf("list wallets: %w", err)
	}

	walletID := ""
	if resp.Payload != nil {
		walletID, err = findWalletIDByName(resp.Payload.Wallets, cfg.TurnkeyWalletName)
		if err != nil {
			return "", err
		}
	}

	if walletID != "" {
		return walletID, nil
	}

	if cfg.WalletNameFromEnv {
		return "", fmt.Errorf("TURNKEY_WALLET_NAME=%q not found", cfg.TurnkeyWalletName)
	}

	newWalletID, _, err := createTurnkeyWallet(client, cfg.TurnkeyOrgID, cfg.TurnkeyWalletName)
	if err != nil {
		return "", err
	}
	return newWalletID, nil
}

func listTurnkeyEthereumAccounts(client *sdk.Client, orgID string, walletID string) ([]walletAccount, error) {
	params := wallets.NewGetWalletAccountsParams().WithBody(&models.GetWalletAccountsRequest{
		OrganizationID: &orgID,
		WalletID:       &walletID,
	})
	resp, err := client.V0().Wallets.GetWalletAccounts(params, client.Authenticator)
	if err != nil {
		return nil, fmt.Errorf("list wallet accounts: %w", err)
	}

	out := make([]walletAccount, 0)
	if resp.Payload == nil {
		return out, nil
	}

	for _, account := range resp.Payload.Accounts {
		if account == nil || account.Address == nil || account.AddressFormat == nil || account.WalletID == nil {
			continue
		}
		if *account.AddressFormat != models.AddressFormatEthereum {
			continue
		}
		out = append(out, walletAccount{
			WalletID: *account.WalletID,
			Address:  ethcommon.HexToAddress(*account.Address),
			Path:     stringOrEmpty(account.Path),
		})
	}

	return out, nil
}

func createTurnkeyWallet(client *sdk.Client, orgID string, walletName string) (string, ethcommon.Address, error) {
	requestType := models.CreateWalletRequestTypeACTIVITYTYPECREATEWALLET
	path := defaultEthereumDerivationPath

	request := &models.CreateWalletRequest{
		OrganizationID: &orgID,
		TimestampMs:    util.RequestTimestamp(),
		Type:           &requestType,
		Parameters: &models.CreateWalletIntent{
			WalletName: &walletName,
			Accounts: []*models.WalletAccountParams{
				{
					AddressFormat: models.AddressFormatEthereum.Pointer(),
					Curve:         models.CurveSecp256k1.Pointer(),
					PathFormat:    models.PathFormatBip32.Pointer(),
					Path:          &path,
				},
			},
		},
	}

	resp, err := client.V0().Wallets.CreateWallet(
		wallets.NewCreateWalletParams().WithBody(request),
		client.Authenticator,
	)
	if err != nil {
		return "", ethcommon.Address{}, fmt.Errorf("create wallet %q: %w", walletName, err)
	}
	if resp.Payload == nil || resp.Payload.Activity == nil || resp.Payload.Activity.Result == nil {
		return "", ethcommon.Address{}, fmt.Errorf("create wallet %q: empty activity payload", walletName)
	}
	result := resp.Payload.Activity.Result.CreateWalletResult
	if result == nil || result.WalletID == nil || len(result.Addresses) == 0 {
		return "", ethcommon.Address{}, fmt.Errorf("create wallet %q: missing wallet ID or address", walletName)
	}

	return *result.WalletID, ethcommon.HexToAddress(result.Addresses[0]), nil
}

func createTurnkeyWalletAccount(client *sdk.Client, orgID string, walletID string) (ethcommon.Address, error) {
	nextIndex, err := nextEthereumDerivationIndex(client, orgID, walletID)
	if err != nil {
		return ethcommon.Address{}, err
	}

	path := fmt.Sprintf("m/44'/60'/0'/0/%d", nextIndex)
	requestType := models.CreateWalletAccountsRequestTypeACTIVITYTYPECREATEWALLETACCOUNTS

	request := &models.CreateWalletAccountsRequest{
		OrganizationID: &orgID,
		TimestampMs:    util.RequestTimestamp(),
		Type:           &requestType,
		Parameters: &models.CreateWalletAccountsIntent{
			WalletID: &walletID,
			Accounts: []*models.WalletAccountParams{
				{
					AddressFormat: models.AddressFormatEthereum.Pointer(),
					Curve:         models.CurveSecp256k1.Pointer(),
					PathFormat:    models.PathFormatBip32.Pointer(),
					Path:          &path,
				},
			},
		},
	}

	resp, err := client.V0().Wallets.CreateWalletAccounts(
		wallets.NewCreateWalletAccountsParams().WithBody(request),
		client.Authenticator,
	)
	if err != nil {
		return ethcommon.Address{}, fmt.Errorf("create wallet account for wallet %s: %w", walletID, err)
	}
	if resp.Payload == nil || resp.Payload.Activity == nil || resp.Payload.Activity.Result == nil {
		return ethcommon.Address{}, fmt.Errorf("create wallet account for wallet %s: empty activity payload", walletID)
	}
	result := resp.Payload.Activity.Result.CreateWalletAccountsResult
	if result == nil || len(result.Addresses) == 0 {
		return ethcommon.Address{}, fmt.Errorf("create wallet account for wallet %s: missing address", walletID)
	}

	return ethcommon.HexToAddress(result.Addresses[0]), nil
}

func nextEthereumDerivationIndex(client *sdk.Client, orgID string, walletID string) (int, error) {
	accounts, err := listTurnkeyEthereumAccounts(client, orgID, walletID)
	if err != nil {
		return 0, err
	}
	maxIndex := -1
	for _, account := range accounts {
		idx, ok := parseEthereumBIP44PathIndex(account.Path)
		if ok && idx > maxIndex {
			maxIndex = idx
		}
	}
	return maxIndex + 1, nil
}

func parseEthereumBIP44PathIndex(path string) (int, bool) {
	path = strings.TrimSpace(path)
	const prefix = "m/44'/60'/0'/0/"
	if !strings.HasPrefix(path, prefix) {
		return 0, false
	}
	tail := strings.TrimSpace(path[len(prefix):])
	if tail == "" {
		return 0, false
	}
	parsed, err := strconv.Atoi(tail)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func exportAndDecryptWalletAccount(client *sdk.Client, cfg bootstrapConfig, address ethcommon.Address) ([]byte, error) {
	enclavePublicKey, err := util.HexToPublicKey(encryptionkey.SignerProductionPublicKey)
	if err != nil {
		return nil, fmt.Errorf("decode turnkey enclave public key: %w", err)
	}

	enclaveClient, err := enclave_encrypt.NewEnclaveEncryptClient(enclavePublicKey)
	if err != nil {
		return nil, fmt.Errorf("create enclave decrypt client: %w", err)
	}

	targetPublicKeyBytes, err := enclaveClient.TargetPublic()
	if err != nil {
		return nil, fmt.Errorf("generate target encryption key: %w", err)
	}
	targetPublicKeyHex := hex.EncodeToString(targetPublicKeyBytes)

	orgID := cfg.TurnkeyOrgID
	requestType := models.ExportWalletAccountRequestTypeACTIVITYTYPEEXPORTWALLETACCOUNT
	addr := address.Hex()

	resp, err := client.V0().Wallets.ExportWalletAccount(
		wallets.NewExportWalletAccountParams().WithBody(&models.ExportWalletAccountRequest{
			OrganizationID: &orgID,
			TimestampMs:    util.RequestTimestamp(),
			Type:           &requestType,
			Parameters: &models.ExportWalletAccountIntent{
				Address:         &addr,
				TargetPublicKey: &targetPublicKeyHex,
			},
		}),
		client.Authenticator,
	)
	if err != nil {
		return nil, fmt.Errorf("export wallet account %s: %w", address.Hex(), err)
	}

	if resp.Payload == nil || resp.Payload.Activity == nil || resp.Payload.Activity.Result == nil {
		return nil, fmt.Errorf("export wallet account %s: empty activity payload", address.Hex())
	}

	result := resp.Payload.Activity.Result.ExportWalletAccountResult
	if result == nil || result.ExportBundle == nil {
		return nil, fmt.Errorf("export wallet account %s: export bundle missing", address.Hex())
	}

	decryptedPayload, err := enclaveClient.Decrypt([]byte(*result.ExportBundle), cfg.TurnkeyOrgID)
	if err != nil {
		return nil, fmt.Errorf("decrypt export bundle for %s: %w", address.Hex(), err)
	}

	privateKeyBytes, err := parsePrivateKeyBytes(decryptedPayload)
	if err != nil {
		return nil, fmt.Errorf("parse exported private key for %s: %w", address.Hex(), err)
	}

	return privateKeyBytes, nil
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
