// 参加・資格更新のTLS境界と結果不明の隔離を試験する。鍵と資格は出力へ含めない。
package control

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func provisionResponse(t *testing.T, f *controlFixture, version int64, overrides ...map[string]any) map[string]any {
	t.Helper()
	now := time.Now().Unix()
	claims := map[string]any{"iss": "https://control.example.test", "aud": "tv-node-agent", "sub": f.identity.NodeID, "iat": now, "exp": now + 300, "jti": "credential-provision-01", "tenantId": f.identity.TenantID, "environment": f.identity.Environment, "nodeId": f.identity.NodeID, "nodeRole": f.identity.Role, "credentialVersion": version}
	for _, fields := range overrides {
		for name, value := range fields {
			claims[name] = value
		}
	}
	token := f.sign(t, claims, "tv-node+jwt")
	return map[string]any{"nodeId": f.identity.NodeID, "nodeRole": f.identity.Role, "credentialVersion": version, "expiresAt": now + 300, "accessToken": token}
}

func provisionServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	return server, roots
}

func newProvisionFixture(t *testing.T, f *controlFixture, endpoint string, roots *x509.CertPool) *Provisioner {
	t.Helper()
	journal := openTestJournal(t, filepath.Join(t.TempDir(), "enrollment"), 16)
	client, err := NewProvisioner(ProvisionConfig{Endpoint: endpoint, Roots: roots, Identity: f.identity, Verifier: f.verifier, DeviceKey: f.deviceKey, DeviceKeyID: "device-test-key", Journal: journal})
	if err != nil {
		t.Fatal("参加Clientの構築に失敗")
	}
	t.Cleanup(client.Close)
	return client
}

func writeProvision(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Error("試験応答を書き込めません")
	}
}

// 端末証明の署名と操作・challengeの対応を、受信したバイト列のまま照合する。
func checkProvisionProof(t *testing.T, f *controlFixture, proof, purpose, challenge string) {
	t.Helper()
	parts := strings.Split(proof, ".")
	if len(parts) != 3 {
		t.Error("端末証明の形式が不正")
		return
	}
	signature, err := base64URL.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(f.deviceKey.Public().(ed25519.PublicKey), []byte(parts[0]+"."+parts[1]), signature) {
		t.Error("端末証明の署名が不正")
		return
	}
	raw, err := base64URL.DecodeString(parts[1])
	if err != nil {
		t.Error("端末証明を解析できません")
		return
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Error("端末証明を解析できません")
		return
	}
	digest := sha256.Sum256([]byte(challenge))
	if claims["purpose"] != purpose || claims["challengeHash"] != hex.EncodeToString(digest[:]) {
		t.Error("操作またはchallengeが端末証明と一致しません")
	}
}

func TestProvisionJoinRotateAndNoSecretHeaders(t *testing.T) {
	f := newControlFixture(t)
	var requests atomic.Int32
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != "POST" || r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "" || r.Header.Get("Accept-Encoding") != "" {
			t.Error("Node専用のHTTP境界が不正")
		}
		var value map[string]string
		if err := json.NewDecoder(r.Body).Decode(&value); err != nil {
			t.Error("要求本文を解析できません")
			return
		}
		switch r.URL.Path {
		case "/nodes/join":
			if r.Header.Get("Authorization") != "" || value["nodeId"] != f.identity.NodeID || len(value) != 3 {
				t.Error("参加要求が不正")
			}
			checkProvisionProof(t, f, value["proof"], "join", value["code"])
			writeProvision(t, w, provisionResponse(t, f, 1))
		case "/nodes/rotate":
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || len(value) != 1 {
				t.Error("更新要求が不正")
			}
			checkProvisionProof(t, f, value["proof"], "rotate", "credential-provision-01")
			writeProvision(t, w, provisionResponse(t, f, 2))
		default:
			t.Error("未知のHTTP操作")
		}
	})
	client := newProvisionFixture(t, f, server.URL, roots)
	if _, _, err := client.Current(); !errors.Is(err, ErrCredentials) || client.Status() != NeedsJoin {
		t.Fatal("参加前に資格を利用できてしまう")
	}
	if err := client.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	if _, credential, err := client.Current(); err != nil || credential.Version != 1 || client.Status() != CredentialReady {
		t.Fatal("参加後の資格を確認できません")
	}
	if err := client.Rotate(context.Background()); err != nil {
		t.Fatal("更新に失敗")
	}
	if _, credential, err := client.Current(); err != nil || credential.Version != 2 || requests.Load() != 2 {
		t.Fatal("更新後の資格を確認できません")
	}
}

func TestProvisionLostResponseQuarantinesAndRejoins(t *testing.T) {
	f := newControlFixture(t)
	var requests atomic.Int32
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		if n == 2 {
			// サーバーで更新が確定した後の応答喪失を再現する。旧資格を再使用させない。
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			if _, err := io.WriteString(w, "{"); err != nil {
				t.Error("切断fixtureを書き込めません")
			}
			return
		}
		writeProvision(t, w, provisionResponse(t, f, int64(n)))
	})
	client := newProvisionFixture(t, f, server.URL, roots)
	if err := client.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	if err := client.Rotate(context.Background()); !errors.Is(err, ErrRecoveryRequired) || client.Status() != RecoveryRequired {
		t.Fatal("結果不明を成功として扱った")
	}
	if _, _, err := client.Current(); !errors.Is(err, ErrCredentials) {
		t.Fatal("結果不明の旧資格を返した")
	}
	if err := client.Rotate(context.Background()); !errors.Is(err, ErrCredentials) || requests.Load() != 2 {
		t.Fatal("結果不明の更新を再送した")
	}
	if err := client.Join(context.Background(), strings.Repeat("b", 43)); err != nil {
		t.Fatal("管理者が再発行した権利で復旧できません")
	}
	if _, credential, err := client.Current(); err != nil || credential.Version != 3 {
		t.Fatal("新世代で復旧できません")
	}
}

func TestProvisionRejectsUntrustedReplies(t *testing.T) {
	for _, name := range []string{"version", "expiry", "node", "role", "tenant", "environment", "audience", "expired", "fraction", "overflow", "token", "unknown", "duplicate", "large", "type", "cache", "encoding", "status", "redirect"} {
		t.Run(name, func(t *testing.T) {
			f := newControlFixture(t)
			var requests atomic.Int32
			server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				value := provisionResponse(t, f, 1)
				switch name {
				case "tenant":
					value = provisionResponse(t, f, 1, map[string]any{"tenantId": "another-household"})
				case "environment":
					value = provisionResponse(t, f, 1, map[string]any{"environment": "staging"})
				case "audience":
					value = provisionResponse(t, f, 1, map[string]any{"aud": "browser-api"})
				case "expired":
					value = provisionResponse(t, f, 1, map[string]any{"iat": time.Now().Unix() - 300, "exp": time.Now().Unix() - 1})
				case "fraction":
					value["credentialVersion"] = json.Number("1.5")
				case "overflow":
					value["credentialVersion"] = json.Number("9007199254740992")
				case "version":
					value["credentialVersion"] = 2
				case "expiry":
					value["expiresAt"] = time.Now().Unix() + 600
				case "node":
					value["nodeId"] = "another-node"
				case "role":
					value["nodeRole"] = "encoder"
				case "token":
					value["accessToken"] = f.credential + "x"
				case "unknown":
					value["secret"] = "synthetic"
				case "duplicate", "large":
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Cache-Control", "no-store")
					body := `{"nodeId":"one","nodeId":"two"}`
					if name == "large" {
						body = strings.Repeat(" ", 16385)
					}
					if _, err := io.WriteString(w, body); err != nil {
						t.Error("不正応答を書き込めません")
					}
					return
				case "status":
					w.WriteHeader(503)
					return
				case "redirect":
					w.Header().Set("Location", "/nodes/join")
					w.WriteHeader(307)
					return
				}
				if name == "type" || name == "cache" || name == "encoding" {
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Cache-Control", "no-store")
					if name == "type" {
						w.Header().Set("Content-Type", "text/plain")
					}
					if name == "cache" {
						w.Header().Del("Cache-Control")
					}
					if name == "encoding" {
						w.Header().Set("Content-Encoding", "gzip")
					}
					if err := json.NewEncoder(w).Encode(value); err != nil {
						t.Error("不正応答を書き込めません")
					}
					return
				}
				writeProvision(t, w, value)
			})
			client := newProvisionFixture(t, f, server.URL, roots)
			if err := client.Join(context.Background(), strings.Repeat("a", 43)); !errors.Is(err, ErrRecoveryRequired) || requests.Load() != 1 {
				t.Fatal("不正応答を受理、または自動再送した")
			}
			if _, _, err := client.Current(); !errors.Is(err, ErrCredentials) {
				t.Fatal("不正応答の資格を利用できてしまう")
			}
		})
	}
}

// JSON Schemaで整数となる小数・指数表記も受け付け、言語ごとの文字列表現で契約を狭めない。
func TestProvisionIntegerRepresentations(t *testing.T) {
	f := newControlFixture(t)
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		value := provisionResponse(t, f, 1)
		value["credentialVersion"] = json.Number("1.0")
		value["expiresAt"] = json.Number(strconv.FormatInt(value["expiresAt"].(int64), 10) + "e0")
		writeProvision(t, w, value)
	})
	client := newProvisionFixture(t, f, server.URL, roots)
	if err := client.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("Schemaで整数と認められる応答を拒否した")
	}
}

func TestProvisionInputCancellationAndConcurrentRotation(t *testing.T) {
	f := newControlFixture(t)
	var requests atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 2 {
			close(entered)
			<-release
		}
		writeProvision(t, w, provisionResponse(t, f, int64(requests.Load())))
	})
	client := newProvisionFixture(t, f, server.URL, roots)
	if err := client.Join(context.Background(), "invalid"); err == nil || requests.Load() != 0 {
		t.Fatal("不正な参加コードを送信した")
	}
	if err := client.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := client.Rotate(ctx); !errors.Is(err, context.Canceled) || requests.Load() != 1 {
		t.Fatal("送信前の中断を処理できません")
	}
	if _, _, err := client.Current(); err != nil {
		t.Fatal("送信前の中断で資格を捨てた")
	}
	done := make(chan error, 1)
	go func() { done <- client.Rotate(context.Background()) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("更新を開始できません")
	}
	if err := client.Rotate(context.Background()); err == nil {
		close(release)
		t.Fatal("更新を並行送信した")
	}
	if _, _, err := client.Current(); !errors.Is(err, ErrCredentials) {
		close(release)
		t.Fatal("更新途中の旧資格を返した")
	}
	close(release)
	if err := <-done; err != nil || requests.Load() != 2 {
		t.Fatal("更新が失敗、または重複送信した")
	}
}

func TestProvisionEndpointAndCertificateBoundary(t *testing.T) {
	f := newControlFixture(t)
	journal := openTestJournal(t, filepath.Join(t.TempDir(), "endpoint-state"), 16)
	for _, endpoint := range []string{"http://example.invalid", "https://name:pass@example.invalid", "https://example.invalid/nodes/join", "https://example.invalid?", "https://example.invalid#fragment", "https://example.invalid/%2f"} {
		if _, err := NewProvisioner(ProvisionConfig{Endpoint: endpoint, Verifier: f.verifier, Identity: f.identity, DeviceKey: f.deviceKey, DeviceKeyID: "device-key", Journal: journal}); err == nil {
			t.Fatal("不正な接続先を許可した")
		}
	}
	server, _ := provisionServer(t, func(w http.ResponseWriter, r *http.Request) { t.Error("未信頼TLSの先へ資格を送った") })
	client := newProvisionFixture(t, f, server.URL, nil)
	if err := client.Join(context.Background(), strings.Repeat("a", 43)); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal("未信頼TLSを許可した")
	}
}

func TestProvisionRejectsRollbackAndRotationJump(t *testing.T) {
	for _, next := range []int64{1, 3} {
		t.Run(string(rune('0'+next)), func(t *testing.T) {
			f := newControlFixture(t)
			var requests atomic.Int32
			server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
				version := int64(1)
				if requests.Add(1) == 2 {
					version = next
				}
				writeProvision(t, w, provisionResponse(t, f, version))
			})
			client := newProvisionFixture(t, f, server.URL, roots)
			if err := client.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
				t.Fatal("参加に失敗")
			}
			if err := client.Rotate(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
				t.Fatal("更新で同世代または飛び越した世代を受理した")
			}
			if err := client.Join(context.Background(), strings.Repeat("b", 43)); !errors.Is(err, ErrRecoveryRequired) {
				t.Fatal("再参加で既知の旧世代を受理した")
			}
		})
	}
}

func TestProvisionCancellationAfterDispatchRequiresRecovery(t *testing.T) {
	f := newControlFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	var requests atomic.Int32
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		close(entered)
		<-release
	})
	client := newProvisionFixture(t, f, server.URL, roots)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Join(ctx, strings.Repeat("a", 43)) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("参加要求が届きません")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrRecoveryRequired) || client.Status() != RecoveryRequired || requests.Load() != 1 {
			t.Fatal("送信後の中断を未実行として扱った")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("HTTP処理を中断できません")
	}
}

func TestProvisionExpiryRequiresNewJoin(t *testing.T) {
	f := newControlFixture(t)
	var requests atomic.Int32
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		writeProvision(t, w, provisionResponse(t, f, 1))
	})
	client := newProvisionFixture(t, f, server.URL, roots)
	if err := client.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	client.now = func() time.Time { return time.Now().Add(301 * time.Second) }
	if client.Status() != NeedsJoin {
		t.Fatal("期限切れを利用可能と表示した")
	}
	if _, _, err := client.Current(); !errors.Is(err, ErrCredentials) {
		t.Fatal("期限切れ資格を返した")
	}
	if err := client.Rotate(context.Background()); !errors.Is(err, ErrCredentials) || requests.Load() != 1 {
		t.Fatal("期限切れ資格で更新を送信した")
	}
}
