// v2検証器の並行利用と鍵・用途の分離を合成鍵で確認する。秘密値やJWSをログへ出さない。
package wire

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"
)

func permitFixture(t *testing.T) (PermitV2Claims, PermitV2Context, PermitV2PublicKey, ed25519.PrivateKey) {
	t.Helper()
	raw, err := os.ReadFile("../../../docs/proposals/capture-permit-v2/example.json")
	if err != nil {
		t.Fatal("合成claimsを読み込めません")
	}
	var example struct {
		Claims PermitV2Claims `json:"claims"`
	}
	if json.Unmarshal(raw, &example) != nil {
		t.Fatal("合成claimsの形式が不正です")
	}
	claims := example.Claims
	context := PermitV2Context{PermitV2Binding: claims.PermitV2Binding, Now: claims.IssuedAt, MaxObservedTime: claims.IssuedAt, MaxPermitLifetime: 3600, MaxOfflineSeconds: 1800, CaptureEarliest: claims.NotBefore, CaptureLatest: claims.ExpiresAt, MaxSpoolBytes: claims.SpoolMaxBytes, AnchorKnown: true}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("合成鍵を生成できません")
	}
	key := PermitV2PublicKey{Alg: "Ed25519", Kty: "OKP", Crv: "Ed25519", X: base64.RawURLEncoding.EncodeToString(public), Kid: "permit-key-unit"}
	return claims, context, key, private
}
func permitSigned(t *testing.T, claims PermitV2Claims, key ed25519.PrivateKey, kid, alg, typ string) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": alg, "typ": typ, "kid": kid})
	if err != nil {
		t.Fatal("合成headerを作れません")
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal("合成claimsを作れません")
	}
	raw := encoding.EncodeToString(header) + "." + encoding.EncodeToString(payload)
	return raw + "." + encoding.EncodeToString(ed25519.Sign(key, []byte(raw)))
}

func TestPermitV2ParallelAndPurposeIsolation(t *testing.T) {
	claims, context, key, private := permitFixture(t)
	verifier, err := NewCapturePermitV2Verifier(claims.Issuer, []PermitV2PublicKey{key})
	if err != nil {
		t.Fatal("専用鍵を構成できません")
	}
	token := permitSigned(t, claims, private, key.Kid, "Ed25519", "telestra-capture-permit-v2+jwt")
	var group sync.WaitGroup
	for range 16 {
		group.Add(1)
		go func() {
			defer group.Done()
			for range 20 {
				result, err := verifier.Verify(token, context)
				if err != nil || result.Window != "active" || result.ExecutionAuthorized {
					t.Error("並行検証の結果が一致しません")
				}
			}
		}()
	}
	group.Wait()
	// 同じ曲線と公開鍵でも、v2の許可を旧Node接続資格へ転用できない。
	old, err := NewVerifier(claims.Issuer, []PublicJWK{{Kty: key.Kty, Crv: key.Crv, X: key.X, Kid: key.Kid}})
	if err != nil {
		t.Fatal("旧プロファイルの試験構成を作れません")
	}
	if _, err := old.VerifyCredential(token, Identity{NodeID: claims.NodeID, TenantID: claims.TenantID, Environment: claims.Environment, Role: "tuner"}, time.Unix(context.Now, 0)); err == nil {
		t.Fatal("v2をNode資格へ転用できてしまいます")
	}
	// 通常の資格世代は検証器の入力にない。失効世代が進んだ時だけ旧許可を拒否する。
	context.AuthorizationEpoch++
	if _, err := verifier.Verify(token, context); err == nil {
		t.Fatal("旧認可世代を拒否できません")
	}
	context.AuthorizationEpoch--
	if _, err := verifier.Verify(token, context); err != nil {
		t.Fatal("独立した認可世代で検証できません")
	}
}

func TestPermitV2KeySetLimitsAndRotation(t *testing.T) {
	claims, context, key, private := permitFixture(t)
	for _, keys := range [][]PermitV2PublicKey{nil, {key, key}, {key, key, key, key, key, key, key, key, key}} {
		if _, err := NewCapturePermitV2Verifier(claims.Issuer, keys); err == nil {
			t.Fatal("不正な鍵集合を拒否できません")
		}
	}
	for _, issuer := range []string{"http://example.invalid", "https://user@example.invalid", "https://example.invalid?keys=1", "https://example.invalid/#fragment"} {
		if _, err := NewCapturePermitV2Verifier(issuer, []PermitV2PublicKey{key}); err == nil {
			t.Fatal("許可外の発行者を拒否できません")
		}
	}
	verifier, err := NewCapturePermitV2Verifier(claims.Issuer, []PermitV2PublicKey{key})
	if err != nil {
		t.Fatal("専用鍵を構成できません")
	}
	token := permitSigned(t, claims, private, key.Kid, "Ed25519", "telestra-capture-permit-v2+jwt")
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("更新鍵を生成できません")
	}
	replacement := key
	replacement.X = encoding.EncodeToString(public)
	rotated, err := NewCapturePermitV2Verifier(claims.Issuer, []PermitV2PublicKey{replacement})
	if err != nil {
		t.Fatal("更新鍵を構成できません")
	}
	if _, err := rotated.Verify(token, context); err == nil {
		t.Fatal("差替え後の鍵集合で旧署名を拒否できません")
	}
	if _, err := verifier.Verify(token, context); err != nil {
		t.Fatal("独立した鍵集合が変更されています")
	}
	key.Alg = "EdDSA"
	if _, err := NewCapturePermitV2Verifier(claims.Issuer, []PermitV2PublicKey{key}); err == nil {
		t.Fatal("旧アルゴリズムを拒否できません")
	}
}
