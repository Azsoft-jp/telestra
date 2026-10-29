// policyとPermitの発行者・用途・期限を合成署名で照合し、混同と実行許可を拒否する。
package wire

import (
	"crypto/ed25519"
	"encoding/json"
	"sync"
	"testing"
)

func policyTestSign(t *testing.T, value any, key ed25519.PrivateKey, kid, typ string) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "Ed25519", "kid": kid, "typ": typ})
	if err != nil {
		t.Fatal("合成headerを作れません")
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal("合成claimsを作れません")
	}
	input := encoding.EncodeToString(header) + "." + encoding.EncodeToString(body)
	return input + "." + encoding.EncodeToString(ed25519.Sign(key, []byte(input)))
}
func TestPolicyV2IssuerBindingAndParallelVerification(t *testing.T) {
	permit, context, key, private := permitFixture(t)
	claims := CapturePolicyV2Claims{PermitV2Binding: permit.PermitV2Binding, SchemaVersion: 2, Issuer: permit.Issuer, Audience: "telestra-tuner-capture-policy", Subject: permit.NodeID, ID: "policy-wire-unit-01", IssuedAt: permit.IssuedAt, ExpiresAt: permit.ExpiresAt, PermitID: permit.ID, MaxPermitLifetime: context.MaxPermitLifetime, MaxOfflineSeconds: context.MaxOfflineSeconds, CaptureEarliest: context.CaptureEarliest, CaptureLatest: context.CaptureLatest, MaxSpoolBytes: context.MaxSpoolBytes}
	policy, err := NewCapturePolicyV2Verifier(claims.Issuer, []PermitV2PublicKey{key}, 3600)
	if err != nil {
		t.Fatal("policy検証器を作れません")
	}
	permitVerifier, err := NewCapturePermitV2Verifier(claims.Issuer, []PermitV2PublicKey{key})
	if err != nil {
		t.Fatal("Permit検証器を作れません")
	}
	policyRaw := policyTestSign(t, claims, private, key.Kid, "telestra-capture-policy-v2+jwt")
	permitRaw := policyTestSign(t, permit, private, key.Kid, "telestra-capture-permit-v2+jwt")
	identity := Identity{NodeID: permit.NodeID, TenantID: permit.TenantID, Environment: permit.Environment, Role: "tuner"}
	var group sync.WaitGroup
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			for range 10 {
				result, err := policy.VerifyPermit(policyRaw, permitRaw, permitVerifier, identity, context.Now, context.MaxObservedTime)
				if err != nil || result.ExecutionAuthorized || result.Window != "active" {
					t.Error("並行したpolicy検証が一致しません")
				}
			}
		}()
	}
	group.Wait()
	// 両方の署名を個別に信頼していても、別の発行者の成果物を組み合わせない。
	foreign := permit
	foreign.Issuer = "https://other.example.invalid"
	other, err := NewCapturePermitV2Verifier(foreign.Issuer, []PermitV2PublicKey{key})
	if err != nil {
		t.Fatal("別発行者の試験構成を作れません")
	}
	foreignRaw := policyTestSign(t, foreign, private, key.Kid, "telestra-capture-permit-v2+jwt")
	if _, err := other.Verify(foreignRaw, context); err != nil {
		t.Fatal("単独の署名検証に失敗")
	}
	if _, err := policy.VerifyPermit(policyRaw, foreignRaw, other, identity, context.Now, context.MaxObservedTime); err == nil {
		t.Fatal("別発行者のPermitを混入できてしまいます")
	}
	claims.Revoked = true
	revoked := policyTestSign(t, claims, private, key.Kid, "telestra-capture-policy-v2+jwt")
	if result, err := policy.Verify(revoked, identity, context.Now, context.MaxObservedTime); err != nil || !result.Claims.Revoked || result.ExecutionAuthorized {
		t.Fatal("署名済みの割当失効を取得できません")
	}
	if _, err := policy.VerifyPermit(revoked, permitRaw, permitVerifier, identity, context.Now, context.MaxObservedTime); err == nil {
		t.Fatal("失効policyでPermitを使えてしまいます")
	}
}
