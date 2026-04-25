package handlers

import (
	"crypto/sha256"
	"fmt"
)

// errorf is a convenience wrapper for fmt.Errorf.
func errorf(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}

// deriveVaultID produces a deterministic vault identifier from the owner's UID
// and Ed25519 public key, using a double-SHA-256 digest encoded as hex.
func deriveVaultID(uid, ownerPublicKeyHex string) string {
	h := sha256.New()
	h.Write([]byte("lumina-vault-v1:"))
	h.Write([]byte(uid))
	h.Write([]byte(":"))
	h.Write([]byte(ownerPublicKeyHex))
	first := h.Sum(nil)

	h2 := sha256.New()
	h2.Write(first)
	return fmt.Sprintf("%x", h2.Sum(nil))
}
