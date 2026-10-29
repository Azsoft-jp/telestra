// 署名付きpolicyとPermitを別用途で照合する。policyの受信だけでは媒体実行を許可しない。
package wire

import "encoding/json"

// CapturePolicyV2Claimsは確定した割当と許可の上限。現在時刻と観測済み時刻はNode側で扱う。
type CapturePolicyV2Claims struct {
	PermitV2Binding
	SchemaVersion     int    `json:"schemaVersion"`
	Issuer            string `json:"iss"`
	Audience          string `json:"aud"`
	Subject           string `json:"sub"`
	ID                string `json:"jti"`
	IssuedAt          int64  `json:"iat"`
	ExpiresAt         int64  `json:"exp"`
	PermitID          string `json:"permitId"`
	MaxPermitLifetime int64  `json:"maxPermitLifetime"`
	MaxOfflineSeconds int64  `json:"maxOfflineSeconds"`
	CaptureEarliest   int64  `json:"captureEarliest"`
	CaptureLatest     int64  `json:"captureLatest"`
	MaxSpoolBytes     int64  `json:"maxSpoolBytes"`
	Revoked           bool   `json:"revoked"`
}

// VerifiedCapturePolicyは署名検証済みsnapshotであり、最新性や確定保存の証明ではない。
type VerifiedCapturePolicy struct {
	Claims              CapturePolicyV2Claims
	ExecutionAuthorized bool
}

// CapturePolicyV2Verifierはpolicy専用の鍵集合を持つ。Permitや旧接続資格と混同しない。
type CapturePolicyV2Verifier struct {
	signature   *CapturePermitV2Verifier
	maxLifetime int64
}

// NewCapturePolicyV2Verifierは許可期間の上限を必須にし、既定TTLを作らない。
func NewCapturePolicyV2Verifier(issuer string, keys []PermitV2PublicKey, maxLifetime int64) (*CapturePolicyV2Verifier, error) {
	if maxLifetime < 1 || maxLifetime > 9007199254740991 {
		return nil, ErrInvalid
	}
	signature, err := NewCapturePermitV2Verifier(issuer, keys)
	if err != nil {
		return nil, err
	}
	return &CapturePolicyV2Verifier{signature: signature, maxLifetime: maxLifetime}, nil
}

// Verifyは対象・期限・時計を照合する。HTTP失敗や資格期限を失効通知へ読み替えない。
func (v *CapturePolicyV2Verifier) Verify(raw string, expected Identity, now, maxObservedTime int64) (VerifiedCapturePolicy, error) {
	deny := VerifiedCapturePolicy{}
	if !expected.valid() || expected.Role != "tuner" || now < 0 || now > 9007199254740991 || maxObservedTime < 0 || now < maxObservedTime {
		return deny, ErrInvalid
	}
	payload, err := v.signature.verifyCaptureDocument(raw, "CapturePolicyV2Header", "CapturePolicyV2")
	if err != nil {
		return deny, ErrInvalid
	}
	var claims CapturePolicyV2Claims
	if json.Unmarshal(payload, &claims) != nil {
		return deny, ErrInvalid
	}
	if claims.Subject != expected.NodeID || claims.NodeID != expected.NodeID || claims.TenantID != expected.TenantID || claims.Environment != expected.Environment || claims.IssuedAt > now || claims.ExpiresAt <= now || claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > v.maxLifetime || claims.CaptureLatest <= claims.CaptureEarliest || claims.MaxPermitLifetime < 1 || claims.MaxOfflineSeconds > claims.MaxPermitLifetime {
		return deny, ErrInvalid
	}
	return VerifiedCapturePolicy{Claims: claims, ExecutionAuthorized: false}, nil
}

// VerifyPermitは二つの署名を確認してから期待値を構成し、個々のID・世代・期間を一致させる。
func (v *CapturePolicyV2Verifier) VerifyPermit(policyRaw, permitRaw string, permitVerifier *CapturePermitV2Verifier, identity Identity, now, maxObservedTime int64) (VerifiedCapturePermit, error) {
	policy, err := v.Verify(policyRaw, identity, now, maxObservedTime)
	if err != nil || policy.Claims.Revoked || permitVerifier == nil {
		return VerifiedCapturePermit{}, ErrInvalid
	}
	claims := policy.Claims
	context := PermitV2Context{PermitV2Binding: claims.PermitV2Binding, Now: now, MaxObservedTime: maxObservedTime, MaxPermitLifetime: claims.MaxPermitLifetime, MaxOfflineSeconds: claims.MaxOfflineSeconds, CaptureEarliest: claims.CaptureEarliest, CaptureLatest: claims.CaptureLatest, MaxSpoolBytes: claims.MaxSpoolBytes, AnchorKnown: true, Revoked: false}
	result, err := permitVerifier.Verify(permitRaw, context)
	if err != nil || result.Claims.Issuer != claims.Issuer || result.Claims.ID != claims.PermitID || result.Claims.ExpiresAt > claims.ExpiresAt {
		return VerifiedCapturePermit{}, ErrInvalid
	}
	return result, nil
}
