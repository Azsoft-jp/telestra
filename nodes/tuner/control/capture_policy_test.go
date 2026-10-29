// policy読取の実TLS・本文上限・期限を検証する。取得失敗で資格を変更しないことも確認する。
package control

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

func signedPolicyFixture(t *testing.T, f *controlFixture, recordingID string) string {
	t.Helper()
	now := time.Now().Unix()
	claims := wire.CapturePolicyV2Claims{PermitV2Binding: wire.PermitV2Binding{TenantID: f.identity.TenantID, Environment: f.identity.Environment, NodeID: f.identity.NodeID, NodeRole: "tuner", AuthorizationEpoch: 1, AssignmentEpoch: 1, ReservationID: "reservation-policy-unit", ReservationRevision: 1, RecordingID: recordingID, AttemptID: "attempt-policy-unit", BackendID: "backend-policy-unit", ServiceKey: "service-policy-unit", CaptureScope: "service-filtered", StorageScopeID: "scope-policy-unit"}, SchemaVersion: 2, Issuer: "https://control.example.test", Audience: "telestra-tuner-capture-policy", Subject: f.identity.NodeID, ID: "policy-unit-01", IssuedAt: now, ExpiresAt: now + 60, PermitID: "permit-unit-01", MaxPermitLifetime: 60, MaxOfflineSeconds: 30, CaptureEarliest: now, CaptureLatest: now + 60, MaxSpoolBytes: 1024}
	header, err := json.Marshal(map[string]string{"alg": "Ed25519", "typ": "telestra-capture-policy-v2+jwt", "kid": "control-test-key"})
	if err != nil {
		t.Fatal("合成headerを作れません")
	}
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal("合成policyを作れません")
	}
	signing := base64URL.EncodeToString(header) + "." + base64URL.EncodeToString(body)
	return signing + "." + base64URL.EncodeToString(ed25519.Sign(f.serverKey, []byte(signing)))
}
func policyVerifierFixture(t *testing.T, f *controlFixture) *wire.CapturePolicyV2Verifier {
	t.Helper()
	verifier, err := wire.NewCapturePolicyV2Verifier("https://control.example.test", []wire.PermitV2PublicKey{{Alg: "Ed25519", Kty: "OKP", Crv: "Ed25519", X: base64URL.EncodeToString(f.serverKey.Public().(ed25519.PublicKey)), Kid: "control-test-key"}}, 60)
	if err != nil {
		t.Fatal("policy検証器を作れません")
	}
	return verifier
}

func TestCapturePolicyTLSBoundsAndReadOnlyFailures(t *testing.T) {
	f := newControlFixture(t)
	verifier := policyVerifierFixture(t, f)
	valid, wrong := signedPolicyFixture(t, f, "recording-policy-unit"), signedPolicyFixture(t, f, "other-recording-unit")
	var mode atomic.Int32
	var requests, redirected atomic.Int32
	trap, _ := provisionServer(t, func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); w.WriteHeader(500) })
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/nodes/join" {
			writeProvision(t, w, provisionResponse(t, f, 1))
			return
		}
		requests.Add(1)
		if r.URL.Path != "/agent/capture-policy/v2" || r.Method != "POST" || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" || r.Header.Get("Accept-Encoding") != "" || r.Header.Get("Authorization") == "" {
			t.Error("policy要求の境界が不正")
		}
		var input map[string]string
		if json.NewDecoder(r.Body).Decode(&input) != nil || input["recordingId"] != "recording-policy-unit" {
			t.Error("policy要求の本文が不正")
			return
		}
		checkProvisionProof(t, f, input["proof"], "capture-policy", "capture-policy.v2\x00recording-policy-unit\x00credential-provision-01")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		body, err := json.Marshal(map[string]any{"schemaVersion": 2, "policy": valid})
		if err != nil {
			t.Error("合成応答を作れません")
			return
		}
		switch mode.Load() {
		case 1:
			w.Header().Set("Location", trap.URL)
			w.WriteHeader(302)
			return
		case 2:
			w.Header().Del("Cache-Control")
		case 3:
			w.Header().Set("Content-Encoding", "gzip")
		case 4:
			body = []byte(strings.Repeat(" ", controlBytes+1))
		case 5:
			body = []byte(`{"schemaVersion":2,"schemaVersion":2,"policy":"` + valid + `"}`)
		case 6:
			body = []byte(`{"schemaVersion":2,"policy":"` + wrong + `"}`)
		case 7:
			w.WriteHeader(200)
			if flush, ok := w.(http.Flusher); ok {
				flush.Flush()
			}
			<-r.Context().Done()
			return
		}
		// 早期拒否では相手が本文を読まずに閉じるため、書込失敗も試験終了として扱う。
		if _, err := w.Write(body); err != nil {
			return
		}
	})
	p := newProvisionFixture(t, f, server.URL, roots)
	if err := p.Join(context.Background(), strings.Repeat("c", 43)); err != nil {
		t.Fatalf("合成参加失敗 protocol=%t credential=%t transport=%t journal=%t", errors.Is(err, ErrProtocol), errors.Is(err, ErrCredentials), errors.Is(err, ErrTransport), errors.Is(err, ErrJournal))
	}
	before, _, err := p.Current()
	if err != nil {
		t.Fatal("合成資格がありません")
	}
	for _, value := range []int32{0, 1, 2, 3, 4, 5, 6, 0} {
		mode.Store(value)
		received, err := p.FetchCapturePolicy(context.Background(), "recording-policy-unit", verifier, 0)
		if value == 0 {
			if err != nil || received.Verified.ExecutionAuthorized {
				t.Fatal("正常policyを検証できません")
			}
		} else if err == nil {
			t.Fatal("異常なHTTP応答を受け入れています")
		}
		after, _, err := p.Current()
		if err != nil || after != before || p.Status() != CredentialReady {
			t.Fatal("読取失敗で資格を変更しています")
		}
	}
	if redirected.Load() != 0 || requests.Load() != 8 {
		t.Fatal("別URLへの転送または自動再送が発生しました")
	}
	mode.Store(7)
	started := time.Now()
	_, err = p.FetchCapturePolicy(context.Background(), "recording-policy-unit", verifier, 0)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) < 4500*time.Millisecond || time.Since(started) > 8*time.Second {
		t.Fatal("5秒の本文待機上限を確認できません")
	}
}

func TestCapturePolicyConcurrentFetchAndCancellation(t *testing.T) {
	f := newControlFixture(t)
	verifier := policyVerifierFixture(t, f)
	signed := signedPolicyFixture(t, f, "recording-policy-unit")
	entered := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	var blocked atomic.Bool
	blocked.Store(true)
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/nodes/join" {
			writeProvision(t, w, provisionResponse(t, f, 1))
			return
		}
		var input map[string]string
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("合成要求を読み取れません")
			return
		}
		if blocked.Load() {
			close(entered)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(200)
			if flush, ok := w.(http.Flusher); ok {
				flush.Flush()
			}
			select {
			case <-r.Context().Done():
			case <-release:
			}
			return
		}
		writeProvision(t, w, map[string]any{"schemaVersion": 2, "policy": signed})
	})
	p := newProvisionFixture(t, f, server.URL, roots)
	if err := p.Join(context.Background(), strings.Repeat("d", 43)); err != nil {
		t.Fatalf("合成参加失敗 protocol=%t credential=%t transport=%t journal=%t", errors.Is(err, ErrProtocol), errors.Is(err, ErrCredentials), errors.Is(err, ErrTransport), errors.Is(err, ErrJournal))
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := p.FetchCapturePolicy(ctx, "recording-policy-unit", verifier, 0); done <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("policy要求が開始されません")
	}
	if _, err := p.FetchCapturePolicy(context.Background(), "recording-policy-unit", verifier, 0); err == nil {
		t.Fatal("同時読取を拒否できません")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("中断を返せません")
		}
	case <-time.After(time.Second):
		t.Fatal("policy要求を中断できません")
	}
	blocked.Store(false)
	if _, err := p.FetchCapturePolicy(context.Background(), "recording-policy-unit", verifier, 0); err != nil {
		t.Fatal("中断後の読取を復旧できません")
	}
	if p.Status() != CredentialReady {
		t.Fatal("policy読取で資格を隔離しています")
	}
}
