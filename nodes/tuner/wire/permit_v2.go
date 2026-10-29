// Capture Permit v2専用の署名検証。既存Credentialのアルゴリズムや録画実行経路を変更しない。
package wire

import (
	"crypto/ed25519"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// PermitV2Bindingは信頼済みpolicyと照合する境界で、通常のCredential世代を含めない。
type PermitV2Binding struct {
	TenantID            string `json:"tenantId"`
	Environment         string `json:"environment"`
	NodeID              string `json:"nodeId"`
	NodeRole            string `json:"nodeRole"`
	AuthorizationEpoch  int64  `json:"authorizationEpoch"`
	AssignmentEpoch     int64  `json:"assignmentEpoch"`
	ReservationID       string `json:"reservationId"`
	ReservationRevision int64  `json:"reservationRevision"`
	RecordingID         string `json:"recordingId"`
	AttemptID           string `json:"attemptId"`
	BackendID           string `json:"backendId"`
	ServiceKey          string `json:"serviceKey"`
	CaptureScope        string `json:"captureScope"`
	StorageScopeID      string `json:"storageScopeId"`
}

// PermitV2Contextは呼出元で確認したpolicyと時計。取得・署名・永続化はこの検証器の責務外。
type PermitV2Context struct {
	PermitV2Binding
	Now               int64 `json:"now"`
	MaxObservedTime   int64 `json:"maxObservedTime"`
	MaxPermitLifetime int64 `json:"maxPermitLifetime"`
	MaxOfflineSeconds int64 `json:"maxOfflineSeconds"`
	CaptureEarliest   int64 `json:"captureEarliest"`
	CaptureLatest     int64 `json:"captureLatest"`
	MaxSpoolBytes     int64 `json:"maxSpoolBytes"`
	AnchorKnown       bool  `json:"anchorKnown"`
	Revoked           bool  `json:"revoked"`
}

// PermitV2Claimsは署名検証後の値。Storage Grantと実行時の可用性は別途検証する。
type PermitV2Claims struct {
	PermitV2Binding
	SchemaVersion       int    `json:"schemaVersion"`
	Issuer              string `json:"iss"`
	Audience            string `json:"aud"`
	Subject             string `json:"sub"`
	ID                  string `json:"jti"`
	IssuedAt            int64  `json:"iat"`
	NotBefore           int64  `json:"nbf"`
	ExpiresAt           int64  `json:"exp"`
	OfflineAllowedUntil int64  `json:"offlineAllowedUntil"`
	SpoolMaxBytes       int64  `json:"spoolMaxBytes"`
}

// PermitV2PublicKeyは用途別に構成する公開鍵。秘密鍵や他のアルゴリズムを受け付けない。
type PermitV2PublicKey struct {
	Alg string `json:"alg"`
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Kid string `json:"kid"`
}

// VerifiedCapturePermitは待機・期間内の判定だけを返し、実行の許可は常にfalseとする。
type VerifiedCapturePermit struct {
	Claims              PermitV2Claims `json:"claims"`
	Window              string         `json:"window"`
	ExecutionAuthorized bool           `json:"executionAuthorized"`
}

// CapturePermitV2Verifierは不変の公開鍵集合を保持し、ネットワークによる鍵探索を行わない。
type CapturePermitV2Verifier struct {
	issuer string
	keys   map[string]ed25519.PublicKey
}

var permitIssuer = regexp.MustCompile(`^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?$`)
var permitEncoding = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// NewCapturePermitV2VerifierはHTTPSの固定発行者と1〜8本の専用鍵を検証し、鍵を複製する。
func NewCapturePermitV2Verifier(issuer string, keys []PermitV2PublicKey) (*CapturePermitV2Verifier, error) {
	if len(issuer) > 512 || !permitIssuer.MatchString(issuer) || len(keys) < 1 || len(keys) > 8 {
		return nil, ErrInvalid
	}
	result := &CapturePermitV2Verifier{issuer: issuer, keys: map[string]ed25519.PublicKey{}}
	for _, key := range keys {
		raw, err := json.Marshal(key)
		if err != nil {
			return nil, ErrInvalid
		}
		value, err := Decode(raw, 1024)
		if err != nil || Validate("CapturePermitV2Key", value) != nil {
			return nil, ErrInvalid
		}
		decoded, err := permitDecode(key.X)
		if err != nil || len(decoded) != 32 || result.keys[key.Kid] != nil {
			return nil, ErrInvalid
		}
		result.keys[key.Kid] = ed25519.PublicKey(decoded)
	}
	return result, nil
}

func permitDecode(raw string) ([]byte, error) {
	if !permitEncoding.MatchString(raw) {
		return nil, ErrInvalid
	}
	value, err := encoding.DecodeString(raw)
	if err != nil || encoding.EncodeToString(value) != raw {
		return nil, ErrInvalid
	}
	return value, nil
}

// v2の整数は10進整数表記だけに限定し、浮動小数点への丸めで範囲判定をすり抜けさせない。
func permitNumbers(value any) bool {
	switch item := value.(type) {
	case json.Number:
		number, err := strconv.ParseInt(string(item), 10, 64)
		return err == nil && number >= -9007199254740991 && number <= 9007199254740991
	case map[string]any:
		for _, child := range item {
			if !permitNumbers(child) {
				return false
			}
		}
	case []any:
		for _, child := range item {
			if !permitNumbers(child) {
				return false
			}
		}
	}
	return true
}

// 署名対象と固定profileの構造だけを検証する。用途名を受信入力から選ばせない。
func (v *CapturePermitV2Verifier) verifyCaptureDocument(raw, headerDefinition, claimsDefinition string) ([]byte, error) {
	if len(raw) > 8192 {
		return nil, ErrInvalid
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return nil, ErrInvalid
	}
	headerRaw, err := permitDecode(parts[0])
	if err != nil {
		return nil, ErrInvalid
	}
	headerValue, err := Decode(headerRaw, 1024)
	if err != nil || Validate(headerDefinition, headerValue) != nil {
		return nil, ErrInvalid
	}
	header, ok := headerValue.(map[string]any)
	if !ok {
		return nil, ErrInvalid
	}
	key := v.keys[text(header, "kid")]
	signature, err := permitDecode(parts[2])
	if err != nil || len(key) != 32 || len(signature) != 64 || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, ErrInvalid
	}
	payload, err := permitDecode(parts[1])
	if err != nil {
		return nil, ErrInvalid
	}
	value, err := Decode(payload, 8192)
	if err != nil || !permitNumbers(value) || Validate(claimsDefinition, value) != nil {
		return nil, ErrInvalid
	}
	object, ok := value.(map[string]any)
	if !ok || text(object, "iss") != v.issuer {
		return nil, ErrInvalid
	}
	return payload, nil
}

// Verifyは受信JWSのバイト列を検証し、署名だけでは分からない対象・世代・時刻をpolicyと照合する。
func (v *CapturePermitV2Verifier) Verify(raw string, context PermitV2Context) (VerifiedCapturePermit, error) {
	deny := VerifiedCapturePermit{}
	contextRaw, err := json.Marshal(context)
	if err != nil {
		return deny, ErrInvalid
	}
	contextValue, err := Decode(contextRaw, 8192)
	if err != nil || Validate("CapturePermitV2Context", contextValue) != nil || len(raw) > 8192 {
		return deny, ErrInvalid
	}
	payload, err := v.verifyCaptureDocument(raw, "CapturePermitV2Header", "CapturePermitV2")
	if err != nil {
		return deny, ErrInvalid
	}
	var claims PermitV2Claims
	if json.Unmarshal(payload, &claims) != nil {
		return deny, ErrInvalid
	}
	if claims.Issuer != v.issuer || claims.Subject != context.NodeID || claims.PermitV2Binding != context.PermitV2Binding || context.Now < context.MaxObservedTime || context.CaptureLatest <= context.CaptureEarliest || context.MaxPermitLifetime < 1 || claims.IssuedAt > context.Now || claims.IssuedAt > claims.NotBefore || claims.NotBefore >= claims.ExpiresAt || claims.ExpiresAt <= context.Now || claims.NotBefore < context.CaptureEarliest || claims.ExpiresAt > context.CaptureLatest || claims.ExpiresAt-claims.IssuedAt > context.MaxPermitLifetime || claims.OfflineAllowedUntil < claims.NotBefore || claims.OfflineAllowedUntil > claims.ExpiresAt || claims.OfflineAllowedUntil-claims.IssuedAt > context.MaxOfflineSeconds || claims.SpoolMaxBytes > context.MaxSpoolBytes {
		return deny, ErrInvalid
	}
	window := "active"
	if context.Now < claims.NotBefore {
		window = "waiting"
	}
	return VerifiedCapturePermit{Claims: claims, Window: window, ExecutionAuthorized: false}, nil
}
