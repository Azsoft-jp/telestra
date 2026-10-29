// 試験専用鍵で正常系と拒否条件を作り、秘密値やTokenを試験ログへ出さない。
package wire

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Verifier, ed25519.PrivateKey, Identity, time.Time) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("試験鍵の生成に失敗")
	}
	verifier, err := NewVerifier("https://control.example.test", []PublicJWK{{"OKP", "Ed25519", encoding.EncodeToString(public), "control-test-key"}})
	if err != nil {
		t.Fatal(err)
	}
	return verifier, private, Identity{"tuner-local-01", "demo-household", "development", "tuner"}, time.Unix(1793232000, 0)
}
func token(t *testing.T, private ed25519.PrivateKey, claims map[string]any, typ string) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "EdDSA", "kid": "control-test-key", "typ": typ})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	input := encoding.EncodeToString(header) + "." + encoding.EncodeToString(body)
	return input + "." + encoding.EncodeToString(ed25519.Sign(private, []byte(input)))
}
func nodeClaims(identity Identity, now time.Time) map[string]any {
	return map[string]any{"iss": "https://control.example.test", "aud": "tv-node-agent", "sub": identity.NodeID, "iat": now.Unix(), "exp": now.Unix() + 300, "jti": "credential-local-01", "tenantId": identity.TenantID, "environment": identity.Environment, "nodeId": identity.NodeID, "nodeRole": identity.Role, "credentialVersion": 1}
}
func controlClaims(credential Credential, epoch int64, typeName string, kind string, payload map[string]any, now time.Time) map[string]any {
	return map[string]any{"iss": "https://control.example.test", "aud": "tv-node-control", "sub": credential.NodeID, "iat": now.Unix(), "exp": now.Unix() + 30, "jti": "message-control-01", "tenantId": credential.TenantID, "environment": credential.Environment, "nodeId": credential.NodeID, "credentialVersion": credential.Version, "direction": "control-to-node", "envelope": map[string]any{"protocolVersion": 1, "messageId": "message-control-01", "kind": kind, "type": typeName, "nodeId": credential.NodeID, "sessionEpoch": epoch, "issuedAt": now.UTC().Format(time.RFC3339Nano), "expiresAt": now.Add(30 * time.Second).UTC().Format(time.RFC3339Nano), "payload": payload}}
}

func TestCredentialAndSignatureRejection(t *testing.T) {
	verifier, private, identity, now := fixture(t)
	claims := nodeClaims(identity, now)
	valid := token(t, private, claims, "tv-node+jwt")
	credential, err := verifier.VerifyCredential(valid, identity, now)
	if err != nil || credential.Version != 1 || credential.ExpiresAt != now.Unix()+300 {
		t.Fatal("有効な資格を取得できない")
	}
	for _, mutate := range []func(map[string]any){
		func(c map[string]any) { c["roles"] = []string{"admin"} }, func(c map[string]any) { c["aud"] = "tv-api" }, func(c map[string]any) { c["nodeId"] = "tuner-other-01" }, func(c map[string]any) { c["tenantId"] = "foreign-household" }, func(c map[string]any) { c["environment"] = "staging" }, func(c map[string]any) { c["exp"] = now.Unix() }, func(c map[string]any) { c["iat"] = now.Unix() + 1 }, func(c map[string]any) { c["exp"] = now.Unix() + 301 }, func(c map[string]any) { c["credentialVersion"] = 0 },
	} {
		bad := nodeClaims(identity, now)
		mutate(bad)
		if _, err := verifier.VerifyCredential(token(t, private, bad, "tv-node+jwt"), identity, now); !errors.Is(err, ErrInvalid) {
			t.Fatal("不正な資格を受け付けた")
		}
	}
	_, foreign, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("試験鍵の生成に失敗")
	}
	for _, invalid := range []string{strings.Repeat("x", 8193), valid + "=", token(t, foreign, claims, "tv-node+jwt"), token(t, private, claims, "at+jwt")} {
		if _, err := verifier.VerifyCredential(invalid, identity, now); !errors.Is(err, ErrInvalid) {
			t.Fatal("不正な署名または用途を受け付けた")
		}
	}
}

func TestControlGenerationAndDirection(t *testing.T) {
	verifier, private, identity, now := fixture(t)
	credential := Credential{identity, 1, now.Unix() + 300, "credential-local-01"}
	ready := controlClaims(credential, 7, "session.ready", "event", map[string]any{"heartbeatIntervalSeconds": 15, "idleTimeoutSeconds": 45, "resumed": false}, now)
	channel, _, err := verifier.VerifyWelcome(token(t, private, ready, "tv-control+jwt"), credential, 6, now)
	if err != nil || channel.Epoch != 7 {
		t.Fatal("接続通知を検証できない")
	}
	if _, _, err := verifier.VerifyWelcome(token(t, private, ready, "tv-control+jwt"), credential, 7, now); err == nil {
		t.Fatal("接続世代の巻き戻りを許可した")
	}
	for _, mutate := range []func(map[string]any){
		func(c map[string]any) { c["direction"] = "node-to-control" }, func(c map[string]any) { c["credentialVersion"] = 2 }, func(c map[string]any) { c["jti"] = "other-message" }, func(c map[string]any) { c["envelope"].(map[string]any)["sessionEpoch"] = 6 }, func(c map[string]any) { c["envelope"].(map[string]any)["type"] = "shell.exec" }, func(c map[string]any) { c["envelope"].(map[string]any)["payload"].(map[string]any)["shell"] = "id" },
	} {
		claims := controlClaims(credential, 7, "capture.cancel", "command", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}, now)
		mutate(claims)
		if _, err := verifier.VerifyControl(token(t, private, claims, "tv-control+jwt"), channel, now); err == nil {
			t.Fatal("不正な制御を受け付けた")
		}
	}
	claims := controlClaims(credential, 7, "capture.cancel", "command", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}, now)
	if _, err := verifier.VerifyControl(token(t, private, claims, "tv-control+jwt"), channel, now); err != nil {
		t.Fatal(err)
	}
	short := channel
	short.Credential.ExpiresAt = now.Unix() + 10
	if _, err := verifier.VerifyControl(token(t, private, claims, "tv-control+jwt"), short, now); err == nil {
		t.Fatal("資格期限より長い制御を受け付けた")
	}
	encoder := channel
	encoder.Credential.Role = "encoder"
	if _, err := verifier.VerifyControl(token(t, private, claims, "tv-control+jwt"), encoder, now); err == nil {
		t.Fatal("Encoderへ録画制御を許可した")
	}
}

func TestStrictJSONAndSchemaBoundaries(t *testing.T) {
	for _, invalid := range []string{`{"a":1,"a":2}`, `{} {}`, `{"x":`, strings.Repeat("[", 34) + strings.Repeat("]", 34), "{\"x\":\"\xff\"}"} {
		if _, err := Decode([]byte(invalid), 16384); err == nil {
			t.Fatal("不正なJSONを受け付けた")
		}
	}
	for _, invalid := range []string{`{"uptimeSeconds":-1,"spoolBytes":0}`, `{"uptimeSeconds":0,"spoolBytes":0,"url":"http://localhost"}`, `{"uptimeSeconds":9007199254740992,"spoolBytes":0}`, `{"spoolBytes":0}`} {
		value, err := Decode([]byte(invalid), 16384)
		if err != nil {
			t.Fatal(err)
		}
		if Validate("WsHeartbeat", value) == nil {
			t.Fatal("不正なpayloadを受け付けた")
		}
	}
	value, err := Decode([]byte(`{"uptimeSeconds":1e0,"spoolBytes":0}`), 16384)
	if err != nil || Validate("WsHeartbeat", value) != nil {
		t.Fatal("Schemaの整数値を誤拒否した")
	}
	if _, err := dateTime("2016-12-31T23:59:60Z"); err == nil {
		t.Fatal("数値化できない時刻を受け付けた")
	}
}

func TestProofAndEventSigning(t *testing.T) {
	_, private, identity, now := fixture(t)
	proof, err := SignProof(private, "device-test-key", identity, "connect", "credential-local-01", now)
	if err != nil || len(proof) == 0 {
		t.Fatal("端末証明を作れない")
	}
	if _, err := SignProof(private, "device-test-key", identity, "shell", "credential-local-01", now); err == nil {
		t.Fatal("未知用途の証明を作成した")
	}
	credential := Credential{identity, 1, now.Unix() + 2, "credential-local-01"}
	channel := Channel{credential, 1}
	raw, err := SignEvent(private, "device-test-key", channel, "node.heartbeat", map[string]any{"uptimeSeconds": 1, "spoolBytes": 0}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(raw, ".")
	decoded, err := encoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	value, err := Decode(decoded, 16384)
	if err != nil || integer(value.(map[string]any), "exp") != now.Unix()+2 {
		t.Fatal("資格期限を越えた")
	}
	if _, err := SignEvent(private, "device-test-key", channel, "capture.cancel", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}, "", now); err == nil {
		t.Fatal("Nodeから命令を署名した")
	}
	if _, err := SignEvent(private, "device-test-key", channel, "command.ack", map[string]any{"accepted": true, "code": "not implemented"}, "command-local-01", now); err == nil {
		t.Fatal("矛盾したACKを署名した")
	}
}
