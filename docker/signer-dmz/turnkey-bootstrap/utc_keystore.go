package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	ethcommon "github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
	"golang.org/x/crypto/scrypt"
)

// Web3 secret storage (scrypt + aes-128-ctr), compatible with go-livepeer keystore.
// See https://ethereum.org/en/developers/docs/data-structures-and-encoding/web3-secret-storage/
const (
	utcKeystoreVersion = 3
	utcScryptN         = 1 << 18
	utcScryptP         = 1
	utcScryptR         = 8
	utcScryptDKLen     = 32
)

type utcCipherParamsJSON struct {
	IV string `json:"iv"`
}

type utcCryptoJSON struct {
	Cipher       string                 `json:"cipher"`
	CipherText   string                 `json:"ciphertext"`
	CipherParams utcCipherParamsJSON      `json:"cipherparams"`
	KDF          string                 `json:"kdf"`
	KDFParams    map[string]interface{} `json:"kdfparams"`
	MAC          string                 `json:"mac"`
}

type utcEncryptedKeyJSONV3 struct {
	Address string        `json:"address"`
	Crypto  utcCryptoJSON `json:"crypto"`
	ID      string        `json:"id"`
	Version int           `json:"version"`
}

func writeUTCKeystore(
	keystoreDir string,
	privateKey *ecdsa.PrivateKey,
	expectedAddress ethcommon.Address,
	password string,
) error {
	keyID, err := uuid.NewRandom()
	if err != nil {
		return fmt.Errorf("generate keystore uuid: %w", err)
	}

	address := ethcrypto.PubkeyToAddress(privateKey.PublicKey)
	if address != expectedAddress {
		return fmt.Errorf("exported private key resolves to %s but expected %s", address.Hex(), expectedAddress.Hex())
	}

	keyJSON, err := encryptUTCKeyJSON(privateKey, password, keyID)
	if err != nil {
		return fmt.Errorf("encrypt UTC keystore: %w", err)
	}

	filename := filepath.Join(keystoreDir, utcKeyFileName(address))
	if err := writeUTCKeyFile(filename, keyJSON); err != nil {
		return fmt.Errorf("write UTC keystore: %w", err)
	}
	return nil
}

func encryptUTCKeyJSON(privateKey *ecdsa.PrivateKey, password string, keyID uuid.UUID) ([]byte, error) {
	keyBytes := math.PaddedBigBytes(privateKey.D, 32)
	cryptoStruct, err := encryptUTCDataV3(keyBytes, []byte(password), utcScryptN, utcScryptP)
	if err != nil {
		return nil, err
	}

	payload := utcEncryptedKeyJSONV3{
		Address: hex.EncodeToString(ethcrypto.PubkeyToAddress(privateKey.PublicKey).Bytes()),
		Crypto:  cryptoStruct,
		ID:      keyID.String(),
		Version: utcKeystoreVersion,
	}
	return json.Marshal(payload)
}

func encryptUTCDataV3(data, auth []byte, scryptN, scryptP int) (utcCryptoJSON, error) {
	salt := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return utcCryptoJSON{}, fmt.Errorf("read scrypt salt: %w", err)
	}

	derivedKey, err := scrypt.Key(auth, salt, scryptN, utcScryptR, scryptP, utcScryptDKLen)
	if err != nil {
		return utcCryptoJSON{}, err
	}

	iv := make([]byte, aes.BlockSize)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return utcCryptoJSON{}, fmt.Errorf("read aes iv: %w", err)
	}

	cipherText, err := aesCTRXOR(derivedKey[:16], data, iv)
	if err != nil {
		return utcCryptoJSON{}, err
	}

	mac := ethcrypto.Keccak256(derivedKey[16:32], cipherText)
	return utcCryptoJSON{
		Cipher:     "aes-128-ctr",
		CipherText: hex.EncodeToString(cipherText),
		CipherParams: utcCipherParamsJSON{
			IV: hex.EncodeToString(iv),
		},
		KDF: "scrypt",
		KDFParams: map[string]interface{}{
			"n":     scryptN,
			"r":     utcScryptR,
			"p":     scryptP,
			"dklen": utcScryptDKLen,
			"salt":  hex.EncodeToString(salt),
		},
		MAC: hex.EncodeToString(mac),
	}, nil
}

func aesCTRXOR(key, inText, iv []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	stream := cipher.NewCTR(block, iv)
	outText := make([]byte, len(inText))
	stream.XORKeyStream(outText, inText)
	return outText, nil
}

func writeUTCKeyFile(file string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(filepath.Dir(file), "."+filepath.Base(file)+".tmp")
	if err != nil {
		return err
	}

	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), file)
}

func utcKeyFileName(address ethcommon.Address) string {
	ts := time.Now().UTC()
	tz := "Z"
	if name, offset := ts.Zone(); name != "UTC" {
		tz = fmt.Sprintf("%03d00", offset/3600)
	}
	stamp := fmt.Sprintf(
		"%04d-%02d-%02dT%02d-%02d-%02d.%09d%s",
		ts.Year(), ts.Month(), ts.Day(), ts.Hour(), ts.Minute(), ts.Second(), ts.Nanosecond(), tz,
	)
	return fmt.Sprintf("UTC--%s--%s", stamp, hex.EncodeToString(address[:]))
}
