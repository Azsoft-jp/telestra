// 登録済みEd25519鍵でJWSを検証する。受信したURLによる鍵取得とアルゴリズム切替は行わない。
package wire

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

var identifier = regexp.MustCompile(`^[A-Za-z0-9_.:-]{3,128}$`)
var encoding = base64.RawURLEncoding.Strict()

type PublicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Kid string `json:"kid"`
}

// Verifierは設定済み公開鍵だけを保持し、並行検証でも鍵集合を変更しない。
type Verifier struct {
	issuer string
	keys   map[string]ed25519.PublicKey
}

// Issuerは構成済みの発行者を返す。受信Tokenから信頼先を選ぶためには使わない。
func (v *Verifier) Issuer() string { return v.issuer }

// NewVerifierは未知方式、重複kid、不正な鍵長を拒否する。
func NewVerifier(issuer string, keys []PublicJWK) (*Verifier, error) {
	if issuer == "" || len(issuer) > 256 || len(keys) < 1 || len(keys) > 8 {
		return nil, ErrInvalid
	}
	result := &Verifier{issuer: issuer, keys: map[string]ed25519.PublicKey{}}
	for _, key := range keys {
		raw, err := json.Marshal(key)
		if err != nil {
			return nil, ErrInvalid
		}
		value, err := Decode(raw, 1024)
		if err != nil || Validate("PublicJwk", value) != nil {
			return nil, ErrInvalid
		}
		decoded, err := encoding.DecodeString(key.X)
		if err != nil || len(decoded) != ed25519.PublicKeySize || result.keys[key.Kid] != nil {
			return nil, ErrInvalid
		}
		result.keys[key.Kid] = ed25519.PublicKey(decoded)
	}
	return result, nil
}

// Identityは構成ファイルから与える境界で、受信した本文から設定を上書きしない。
type Identity struct {
	NodeID      string
	TenantID    string
	Environment string
	Role        string
}

func (identity Identity) valid() bool {
	return identifier.MatchString(identity.NodeID) && identifier.MatchString(identity.TenantID) &&
		(identity.Environment == "development" || identity.Environment == "staging" || identity.Environment == "production") && (identity.Role == "tuner" || identity.Role == "encoder")
}

type Credential struct {
	Identity
	Version   int64
	ExpiresAt int64
	TokenID   string
}

// VerifyCredentialはNode専用資格の用途・境界・期限を確認し、Browser資格を拒否する。
func (v *Verifier) VerifyCredential(raw string, expected Identity, now time.Time) (Credential, error) {
	if !expected.valid() {
		return Credential{}, ErrInvalid
	}
	claims, err := v.verify(raw, "tv-node+jwt", "NodeClaims", "tv-node-agent", 300, now)
	if err != nil || text(claims, "sub") != expected.NodeID || text(claims, "nodeId") != expected.NodeID || text(claims, "tenantId") != expected.TenantID || text(claims, "environment") != expected.Environment || text(claims, "nodeRole") != expected.Role {
		return Credential{}, ErrInvalid
	}
	return Credential{Identity: expected, Version: integer(claims, "credentialVersion"), ExpiresAt: integer(claims, "exp"), TokenID: text(claims, "jti")}, nil
}
func (v *Verifier) verify(raw, typ, definition, audience string, lifetime int64, now time.Time) (map[string]any, error) {
	maximum := 8192
	if definition == "ControlClaims" {
		maximum = 16384
	}
	if len(raw) > maximum || now.Unix() < 0 {
		return nil, ErrInvalid
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return nil, ErrInvalid
	}
	headerBytes, err := encoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalid
	}
	headerValue, err := Decode(headerBytes, 1024)
	if err != nil {
		return nil, ErrInvalid
	}
	header, ok := headerValue.(map[string]any)
	if !ok || len(header) != 3 || text(header, "alg") != "EdDSA" || text(header, "typ") != typ || !identifier.MatchString(text(header, "kid")) {
		return nil, ErrInvalid
	}
	key := v.keys[text(header, "kid")]
	if key == nil {
		return nil, ErrInvalid
	}
	signature, err := encoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize {
		return nil, ErrInvalid
	}
	// 署名は受信したJWSのバイト列で確認し、JSONの再シリアライズでは照合しない。
	if !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, ErrInvalid
	}
	payload, err := encoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalid
	}
	value, err := Decode(payload, maximum)
	if err != nil || Validate(definition, value) != nil {
		return nil, ErrInvalid
	}
	claims, ok := value.(map[string]any)
	if !ok {
		return nil, ErrInvalid
	}
	issued, expires := integer(claims, "iat"), integer(claims, "exp")
	if text(claims, "iss") != v.issuer || text(claims, "aud") != audience || issued > now.Unix() || expires <= now.Unix() || expires <= issued || expires-issued > lifetime {
		return nil, ErrInvalid
	}
	return claims, nil
}
func text(object map[string]any, name string) string { value, _ := object[name].(string); return value }
func integer(object map[string]any, name string) int64 {
	value, ok := object[name].(json.Number)
	if !ok {
		return -1
	}
	number, err := value.Float64()
	if err != nil {
		return -1
	}
	return int64(number)
}

// SignProofは端末鍵で用途とchallengeを証明する。鍵と本文をエラーへ含めない。
func SignProof(key ed25519.PrivateKey, kid string, identity Identity, purpose, challenge string, now time.Time) (string, error) {
	if !identity.valid() || !identifier.MatchString(kid) || len(challenge) == 0 || len(challenge) > 4096 {
		return "", ErrInvalid
	}
	digest := sha256.Sum256([]byte(challenge))
	id, err := messageID()
	if err != nil {
		return "", err
	}
	claims := map[string]any{"iss": identity.NodeID, "aud": "tv-node-device-proof", "sub": identity.NodeID, "iat": now.Unix(), "exp": now.Unix() + 60, "jti": id, "tenantId": identity.TenantID, "environment": identity.Environment, "nodeId": identity.NodeID, "purpose": purpose, "challengeHash": hex.EncodeToString(digest[:])}
	return sign(key, kid, "tv-device-proof+jwt", "DeviceProof", claims)
}
func sign(key ed25519.PrivateKey, kid, typ, definition string, claims map[string]any) (string, error) {
	if len(key) != ed25519.PrivateKeySize || !identifier.MatchString(kid) {
		return "", ErrInvalid
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", ErrInvalid
	}
	value, err := Decode(payload, 16384)
	if err != nil || Validate(definition, value) != nil {
		return "", ErrInvalid
	}
	header, err := json.Marshal(map[string]string{"alg": "EdDSA", "kid": kid, "typ": typ})
	if err != nil {
		return "", ErrInvalid
	}
	input := encoding.EncodeToString(header) + "." + encoding.EncodeToString(payload)
	result := input + "." + encoding.EncodeToString(ed25519.Sign(key, []byte(input)))
	if len(result) > 16384 {
		return "", ErrInvalid
	}
	return result, nil
}
func messageID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", ErrInvalid
	}
	return hex.EncodeToString(data[:]), nil
}
