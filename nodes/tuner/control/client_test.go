// 実際のローカルWSSで署名、世代、再送、受領待ちを試験する。媒体処理は呼び出さない。
package control

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
	"github.com/coder/websocket"
)

var base64URL = base64.RawURLEncoding

type controlFixture struct {
	serverKey  ed25519.PrivateKey
	deviceKey  ed25519.PrivateKey
	verifier   *wire.Verifier
	identity   wire.Identity
	credential string
	expiry     int64
}

func newControlFixture(t *testing.T) *controlFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("試験鍵の生成に失敗")
	}
	_, device, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("試験鍵の生成に失敗")
	}
	verifier, err := wire.NewVerifier("https://control.example.test", []wire.PublicJWK{{Kty: "OKP", Crv: "Ed25519", X: base64URL.EncodeToString(public), Kid: "control-test-key"}})
	if err != nil {
		t.Fatal(err)
	}
	f := &controlFixture{serverKey: private, deviceKey: device, verifier: verifier, identity: journalIdentity()}
	f.mint(t, 300)
	return f
}
func (f *controlFixture) mint(t *testing.T, lifetime int64) {
	t.Helper()
	now := time.Now().Unix()
	f.expiry = now + lifetime
	f.credential = f.sign(t, map[string]any{"iss": "https://control.example.test", "aud": "tv-node-agent", "sub": f.identity.NodeID, "iat": now, "exp": f.expiry, "jti": "credential-test-01", "tenantId": f.identity.TenantID, "environment": f.identity.Environment, "nodeId": f.identity.NodeID, "nodeRole": f.identity.Role, "credentialVersion": 1}, "tv-node+jwt")
}
func (f *controlFixture) sign(t *testing.T, claims map[string]any, typ string) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "EdDSA", "kid": "control-test-key", "typ": typ})
	if err != nil {
		t.Fatal("試験ヘッダーの生成に失敗")
	}
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal("試験本文の生成に失敗")
	}
	input := base64URL.EncodeToString(header) + "." + base64URL.EncodeToString(body)
	return input + "." + base64URL.EncodeToString(ed25519.Sign(f.serverKey, []byte(input)))
}
func (f *controlFixture) claims(epoch int64, id, typeName string, payload map[string]any) map[string]any {
	now := time.Now().Truncate(time.Second)
	expires := now.Add(30 * time.Second)
	if expires.Unix() > f.expiry {
		expires = time.Unix(f.expiry, 0)
	}
	kind := "event"
	if typeName == "capture.cancel" {
		kind = "command"
	}
	return map[string]any{"iss": "https://control.example.test", "aud": "tv-node-control", "sub": f.identity.NodeID, "iat": now.Unix(), "exp": expires.Unix(), "jti": id, "tenantId": f.identity.TenantID, "environment": f.identity.Environment, "nodeId": f.identity.NodeID, "credentialVersion": 1, "direction": "control-to-node", "envelope": map[string]any{"protocolVersion": 1, "messageId": id, "kind": kind, "type": typeName, "nodeId": f.identity.NodeID, "sessionEpoch": epoch, "issuedAt": now.UTC().Format(time.RFC3339), "expiresAt": expires.UTC().Format(time.RFC3339), "payload": payload}}
}
func (f *controlFixture) send(t *testing.T, ctx context.Context, socket *websocket.Conn, epoch int64, id, typeName string, payload map[string]any) bool {
	t.Helper()
	if err := socket.Write(ctx, websocket.MessageText, []byte(f.sign(t, f.claims(epoch, id, typeName, payload), "tv-control+jwt"))); err != nil {
		t.Error("試験制御の送信に失敗")
		return false
	}
	return true
}
func (f *controlFixture) event(t *testing.T, ctx context.Context, socket *websocket.Conn, epoch int64, typeName string) map[string]any {
	t.Helper()
	kind, raw, err := socket.Read(ctx)
	if err != nil || kind != websocket.MessageText {
		t.Error("Nodeのイベントを受信できない")
		return nil
	}
	parts := strings.Split(string(raw), ".")
	if len(parts) != 3 {
		t.Error("JWS形式が不正")
		return nil
	}
	signature, err := base64URL.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(f.deviceKey.Public().(ed25519.PublicKey), []byte(parts[0]+"."+parts[1]), signature) {
		t.Error("Nodeの署名が不正")
		return nil
	}
	body, err := base64URL.DecodeString(parts[1])
	if err != nil {
		t.Error("Node本文の形式が不正")
		return nil
	}
	value, err := wire.Decode(body, 16384)
	if err != nil || wire.Validate("ControlClaims", value) != nil {
		t.Error("Nodeの契約が不正")
		return nil
	}
	claims := value.(map[string]any)
	envelope := claims["envelope"].(map[string]any)
	if claims["direction"] != "node-to-control" || claims["tenantId"] != f.identity.TenantID || claims["nodeId"] != f.identity.NodeID || envelope["type"] != typeName || envelope["sessionEpoch"] != json.Number(stringInt(epoch)) {
		t.Error("Nodeの方向、境界、世代が不正")
		return nil
	}
	return envelope
}
func stringInt(n int64) string {
	raw, err := json.Marshal(n)
	if err != nil {
		return ""
	}
	return string(raw)
}

func (f *controlFixture) accept(t *testing.T, w http.ResponseWriter, r *http.Request, epoch int64) (*websocket.Conn, context.Context, context.CancelFunc) {
	t.Helper()
	socket, err := websocket.Accept(w, r, nil)
	if err != nil {
		t.Error("Upgradeに失敗")
		return nil, nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	if !f.send(t, ctx, socket, epoch, "welcome-test-"+stringInt(epoch), "session.ready", map[string]any{"heartbeatIntervalSeconds": 15, "idleTimeoutSeconds": 45, "resumed": epoch > 1}) {
		cancel()
		closeTestSocket(t, socket)
		return nil, nil, nil
	}
	return socket, ctx, cancel
}
func (f *controlFixture) hello(t *testing.T, ctx context.Context, socket *websocket.Conn, epoch int64) bool {
	t.Helper()
	event := f.event(t, ctx, socket, epoch, "node.hello")
	if event == nil {
		return false
	}
	payload := event["payload"].(map[string]any)
	if payload["maxConcurrentJobs"] != json.Number("0") || len(payload["capabilities"].([]any)) != 0 {
		t.Error("未実装能力を広告した")
		return false
	}
	if epoch > 1 && payload["resume"].(map[string]any)["lastSessionEpoch"] != json.Number(stringInt(epoch-1)) {
		t.Error("保存済み接続世代を送らなかった")
		return false
	}
	return f.send(t, ctx, socket, epoch, "receipt-hello-"+stringInt(epoch), "control.receipt", map[string]any{"messageId": event["messageId"], "code": "accepted"})
}
func (f *controlFixture) client(t *testing.T, handler http.HandlerFunc, journal *Journal) *Client {
	t.Helper()
	_, endpoint, roots := tlsEndpoint(t, handler)
	transport, err := NewWSS(endpoint, roots)
	if err != nil {
		t.Fatal(err)
	}
	// 命令履歴を先に用意する試験でも、登録済み資格を明示してから接続試験へ進む。
	binding, err := credentialBinding("https://"+strings.TrimSuffix(strings.TrimPrefix(endpoint, "wss://"), "/agent"), f.verifier, f.identity, f.deviceKey, "device-test-key")
	if err != nil {
		t.Fatal("試験の端末束縛を作れません")
	}
	if _, exists, err := journal.loadEnrollment(binding); err != nil {
		t.Fatal("試験の端末束縛を読めません")
	} else if !exists {
		credential, err := f.verifier.VerifyCredential(f.credential, f.identity, time.Now())
		if err != nil {
			t.Fatal("試験資格を検証できません")
		}
		operation, err := journal.beginCredential(binding, 0)
		if err != nil {
			t.Fatal("試験の参加を開始できません")
		}
		if err := journal.finishCredential(binding, operation, f.credential, 0, credential.Version); err != nil {
			t.Fatal("試験の参加を確定できません")
		}
	}
	client, err := NewClient(ClientConfig{Transport: transport, Verifier: f.verifier, Identity: f.identity, Credential: f.credential, DeviceKey: f.deviceKey, DeviceKeyID: "device-test-key", Journal: journal, AgentVersion: "phase01-local"})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestClientHeartbeatAndCancel(t *testing.T) {
	f := newControlFixture(t)
	journal := openTestJournal(t, journalDirectory(t), 32)
	ctx, cancel := context.WithTimeout(context.Background(), 22*time.Second)
	defer cancel()
	client := f.client(t, func(w http.ResponseWriter, r *http.Request) {
		socket, serverCtx, stop := f.accept(t, w, r, 1)
		if socket == nil {
			return
		}
		defer stop()
		defer closeTestSocket(t, socket)
		if !f.hello(t, serverCtx, socket, 1) {
			return
		}
		heartbeat := f.event(t, serverCtx, socket, 1, "node.heartbeat")
		if heartbeat == nil {
			return
		}
		if heartbeat["payload"].(map[string]any)["spoolBytes"] != json.Number("0") {
			t.Error("媒体を扱ったように応答した")
		}
		if !f.send(t, serverCtx, socket, 1, "receipt-heartbeat-01", "control.receipt", map[string]any{"messageId": heartbeat["messageId"], "code": "accepted"}) {
			return
		}
		cancel()
		if _, _, err := socket.Read(serverCtx); err == nil {
			t.Error("中断後も接続が残った")
		}
	}, journal)
	outcome, err := Run(ctx, DefaultPolicy(), Dependencies{Dial: client.Dial})
	if outcome.State != Stopped || outcome.Attempts != 1 || !errors.Is(err, context.Canceled) {
		t.Fatal("Heartbeat後の中断に失敗")
	}
}

func TestClientReconnectReusesDurableResult(t *testing.T) {
	f := newControlFixture(t)
	directory := journalDirectory(t)
	journal := openTestJournal(t, directory, 32)
	var connections atomic.Int32
	proofs := make(chan string, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	client := f.client(t, func(w http.ResponseWriter, r *http.Request) {
		epoch := int64(connections.Add(1))
		proofs <- r.Header.Get("X-TV-Device-Proof")
		socket, serverCtx, stop := f.accept(t, w, r, epoch)
		if socket == nil {
			return
		}
		defer stop()
		defer closeTestSocket(t, socket)
		if !f.hello(t, serverCtx, socket, epoch) {
			return
		}
		if !f.send(t, serverCtx, socket, epoch, "command-repeat-01", "capture.cancel", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}) {
			return
		}
		ack := f.event(t, serverCtx, socket, epoch, "command.ack")
		if ack == nil {
			return
		}
		if ack["correlationId"] != "command-repeat-01" || ack["payload"].(map[string]any)["code"] != "not implemented" {
			t.Error("未実装の応答が不正")
		}
		if epoch == 2 {
			cancel()
			if _, _, err := socket.Read(serverCtx); err == nil {
				t.Error("接続が残った")
			}
		}
		// 1回目は受領通知を返さず切断し、確定済み命令を次の接続で再送する。
	}, journal)
	sleeps := 0
	outcome, err := Run(ctx, Policy{BaseDelay: time.Millisecond, MaxDelay: time.Millisecond, MaxAttempts: 3}, Dependencies{Dial: client.Dial, Random: func() (float64, error) { return 0, nil }, Sleep: func(context.Context, time.Duration) error { sleeps++; return nil }})
	if outcome.State != Stopped || outcome.Attempts != 2 || sleeps != 1 || !errors.Is(err, context.Canceled) {
		t.Fatal("有限再接続と再送が完了しない")
	}
	if <-proofs == <-proofs {
		t.Fatal("接続証明を再利用した")
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	restored := openTestJournal(t, directory, 32)
	command := journalCommand("command-repeat-01", time.Now())
	command.Epoch = 2
	result, replayed, err := restored.Execute(command, time.Now(), func(wire.Envelope) (Result, error) {
		t.Error("確定した命令を再実行した")
		return Result{}, nil
	})
	if err != nil || !replayed || result.Code != "not implemented" {
		t.Fatal("再接続後の応答を永続化していない")
	}
}

func TestClientRejectsWelcomeAndHelloReceipt(t *testing.T) {
	for _, mode := range []string{"old-epoch", "wrong-signature", "foreign-tenant", "wrong-receipt"} {
		t.Run(mode, func(t *testing.T) {
			f := newControlFixture(t)
			journal := openTestJournal(t, journalDirectory(t), 32)
			if mode == "old-epoch" {
				if err := journal.AdvanceEpoch(1); err != nil {
					t.Fatal(err)
				}
			}
			client := f.client(t, func(w http.ResponseWriter, r *http.Request) {
				socket, err := websocket.Accept(w, r, nil)
				if err != nil {
					t.Error("Upgradeに失敗")
					return
				}
				defer closeTestSocket(t, socket)
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				claims := f.claims(1, "welcome-bad-01", "session.ready", map[string]any{"heartbeatIntervalSeconds": 15, "idleTimeoutSeconds": 45, "resumed": false})
				if mode == "foreign-tenant" {
					claims["tenantId"] = "foreign-household"
				}
				raw := f.sign(t, claims, "tv-control+jwt")
				if mode == "wrong-signature" {
					parts := strings.Split(raw, ".")
					signature, decodeErr := base64URL.DecodeString(parts[2])
					if decodeErr != nil {
						t.Error("試験署名の解析に失敗")
						return
					}
					signature[0] ^= 1
					parts[2] = base64URL.EncodeToString(signature)
					raw = strings.Join(parts, ".")
				}
				if err := socket.Write(ctx, websocket.MessageText, []byte(raw)); err != nil {
					t.Error("拒否試験の送信に失敗")
					return
				}
				if mode == "wrong-receipt" {
					event := f.event(t, ctx, socket, 1, "node.hello")
					if event != nil {
						if !f.send(t, ctx, socket, 1, "receipt-bad-01", "control.receipt", map[string]any{"messageId": "unknown-event-01", "code": "accepted"}) {
							return
						}
					}
				}
				if _, _, err := socket.Read(ctx); err == nil {
					t.Error("不正通知の後に通信を継続した")
				}
			}, journal)
			outcome, err := Run(context.Background(), DefaultPolicy(), Dependencies{Dial: client.Dial})
			if outcome.State != Failed || outcome.Attempts != 1 || !errors.Is(err, ErrProtocol) {
				t.Fatal("不正な接続通知を再試行または許可した")
			}
		})
	}
}

func TestClientStopsOnUnknownCommandAndPendingHistory(t *testing.T) {
	for _, mode := range []string{"unknown-command", "pending", "conflict", "old-command", "bad-signature", "unknown-receipt", "backpressure"} {
		t.Run(mode, func(t *testing.T) {
			f := newControlFixture(t)
			journal := openTestJournal(t, journalDirectory(t), 32)
			if mode == "pending" || mode == "conflict" {
				if err := journal.AdvanceEpoch(1); err != nil {
					t.Fatal(err)
				}
				command := journalCommand("command-deny-01", time.Now())
				if mode == "pending" {
					if _, _, err := journal.Execute(command, time.Now(), func(wire.Envelope) (Result, error) { return Result{}, ErrIndeterminate }); !errors.Is(err, ErrIndeterminate) {
						t.Fatal("pendingを作れない")
					}
				} else {
					if _, _, err := journal.Execute(command, time.Now(), noExecution); err != nil {
						t.Fatal(err)
					}
				}
			}
			epoch := int64(1)
			if mode == "pending" || mode == "conflict" {
				epoch = 2
			}
			client := f.client(t, func(w http.ResponseWriter, r *http.Request) {
				socket, serverCtx, stop := f.accept(t, w, r, epoch)
				if socket == nil {
					return
				}
				defer stop()
				defer closeTestSocket(t, socket)
				if !f.hello(t, serverCtx, socket, epoch) {
					return
				}
				claims := f.claims(epoch, "command-deny-01", "capture.cancel", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"})
				envelope := claims["envelope"].(map[string]any)
				if mode == "unknown-command" {
					envelope["type"] = "shell.exec"
				}
				if mode == "old-command" {
					envelope["sessionEpoch"] = 0
				}
				if mode == "conflict" {
					envelope["payload"].(map[string]any)["attemptId"] = "attempt-foreign-01"
				}
				if mode == "unknown-receipt" {
					claims = f.claims(epoch, "receipt-unknown-01", "control.receipt", map[string]any{"messageId": "unknown-event-01", "code": "accepted"})
				}
				raw := f.sign(t, claims, "tv-control+jwt")
				if mode == "bad-signature" {
					raw = raw[:len(raw)-1] + "!"
				}
				if mode == "backpressure" {
					for i := 0; i < 9; i++ {
						if !f.send(t, serverCtx, socket, epoch, "command-deny-01", "capture.cancel", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}) {
							return
						}
						if i < 8 && f.event(t, serverCtx, socket, epoch, "command.ack") == nil {
							return
						}
					}
				} else if err := socket.Write(serverCtx, websocket.MessageText, []byte(raw)); err != nil {
					t.Error("拒否試験の送信に失敗")
					return
				}
				if _, _, err := socket.Read(serverCtx); err == nil {
					t.Error("不正な命令や受領待ち上限を許可した")
				}
			}, journal)
			outcome, err := Run(context.Background(), DefaultPolicy(), Dependencies{Dial: client.Dial})
			if outcome.State != Failed || outcome.Attempts != 1 || !errors.Is(err, ErrProtocol) {
				t.Fatal("拒否条件の後に再接続または処理した")
			}
			if mode == "pending" && !errors.Is(err, ErrIndeterminate) {
				t.Fatal("結果不明の履歴を隠した")
			}
		})
	}
}

// 受領待ちと資格期限は、相手からの通信が続いても延長しない。
func TestClientReceiptAndCredentialDeadlines(t *testing.T) {
	for _, mode := range []string{"hello-timeout", "receipt-timeout", "credential-expired"} {
		t.Run(mode, func(t *testing.T) {
			f := newControlFixture(t)
			journal := openTestJournal(t, journalDirectory(t), 32)
			if mode == "credential-expired" {
				f.mint(t, 3)
			}
			var offset atomic.Int64
			client := f.client(t, func(w http.ResponseWriter, r *http.Request) {
				socket, serverCtx, stop := f.accept(t, w, r, 1)
				if socket == nil {
					return
				}
				defer stop()
				defer closeTestSocket(t, socket)
				if mode == "hello-timeout" {
					if f.event(t, serverCtx, socket, 1, "node.hello") == nil {
						return
					}
				} else {
					if !f.hello(t, serverCtx, socket, 1) {
						return
					}
					if mode == "receipt-timeout" {
						if !f.send(t, serverCtx, socket, 1, "command-deadline-01", "capture.cancel", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}) {
							return
						}
						if f.event(t, serverCtx, socket, 1, "command.ack") == nil {
							return
						}
						offset.Store(31)
					}
				}
				if _, _, err := socket.Read(serverCtx); err == nil {
					t.Error("期限を過ぎても待機を続けた")
				}
			}, journal)
			client.now = func() time.Time { return time.Now().Add(time.Duration(offset.Load()) * time.Second) }
			connected := false
			outcome, err := Run(context.Background(), Policy{BaseDelay: time.Millisecond, MaxDelay: time.Millisecond, MaxAttempts: 1}, Dependencies{Dial: client.Dial, Observe: func(state State, _ int) {
				if state == Connected {
					connected = true
				}
			}})
			if outcome.State != Failed || outcome.Attempts != 1 {
				t.Fatal("期限で接続を停止できない")
			}
			switch mode {
			case "hello-timeout":
				if connected || !errors.Is(err, ErrUnavailable) {
					t.Fatal("受領前に接続成功と扱った")
				}
			case "receipt-timeout":
				if !connected || !errors.Is(err, ErrTransport) {
					t.Fatal("受領期限の切断を確認できない")
				}
			case "credential-expired":
				if !connected || !errors.Is(err, ErrCredentials) {
					t.Fatal("資格期限の停止を確認できない")
				}
			}
		})
	}
}
