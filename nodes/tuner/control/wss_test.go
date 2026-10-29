// ループバックのTLSサーバーでWSS境界を検証する。資格は合成値だけを使う。
package control

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testToken = "a.b.c"

func tlsEndpoint(t *testing.T, handler http.HandlerFunc) (*httptest.Server, string, *x509.CertPool) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	return server, "wss" + strings.TrimPrefix(server.URL, "https") + "/agent", roots
}

func closeTestSocket(t *testing.T, socket *websocket.Conn) {
	t.Helper()
	// 相手の中断で閉じたTCPには終了通知を書けない。接続が閉じた既知の条件だけを許可する。
	if err := socket.CloseNow(); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, syscall.EPIPE) && !errors.Is(err, syscall.ECONNRESET) && !errors.Is(err, io.ErrClosedPipe) {
		t.Error("試験接続の解放に失敗")
	}
}

func TestWSSHeadersTLSAndText(t *testing.T) {
	_, endpoint, roots := tlsEndpoint(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent" || r.Header.Get("Authorization") != "Bearer "+testToken || r.Header.Get("X-TV-Device-Proof") != testToken || r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Sec-WebSocket-Extensions") != "" {
			t.Error("認証ヘッダーまたは制御パスが不正")
			w.WriteHeader(400)
			return
		}
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error("Upgradeに失敗")
			return
		}
		defer closeTestSocket(t, socket)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second*3)
		defer cancel()
		kind, body, err := socket.Read(ctx)
		if err != nil || kind != websocket.MessageText || string(body) != "test-control" {
			t.Error("テキストを受信できない")
			return
		}
		if err := socket.Write(ctx, websocket.MessageText, []byte("test-reply")); err != nil {
			t.Error("返信に失敗")
		}
	})
	transport, err := NewWSS(endpoint, roots)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*4)
	defer cancel()
	socket, err := transport.Dial(ctx, testToken, testToken)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		// 相手による切断後は解放も通信失敗になり得る。未知の失敗は許可しない。
		if err := socket.Close(); err != nil && !errors.Is(err, ErrTransport) {
			t.Error(err)
		}
	}()
	if err := socket.Write(ctx, "test-control"); err != nil {
		t.Fatal(err)
	}
	if body, err := socket.Read(ctx); err != nil || body != "test-reply" {
		t.Fatal("返信を受信できない")
	}
	// 同じ接続先でも、明示した試験CAがなければ証明書検証を通らない。
	untrusted, err := NewWSS(endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := untrusted.Dial(ctx, testToken, testToken); !errors.Is(err, ErrProtocol) {
		t.Fatal("未信頼のTLS証明書を許可した")
	}
}

func TestWSSRedirectAndStatusDenials(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); w.WriteHeader(500) }))
	defer target.Close()
	for _, status := range []int{301, 302, 307, 308, 401, 403, 404, 408, 429, 500, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			_, endpoint, roots := tlsEndpoint(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(status)
			})
			transport, err := NewWSS(endpoint, roots)
			if err != nil {
				t.Fatal(err)
			}
			_, err = transport.Dial(context.Background(), testToken, testToken)
			want := ErrProtocol
			if status == 401 || status == 403 {
				want = ErrCredentials
			}
			if status == 408 || status == 429 || status == 500 || status == 503 {
				want = ErrTransport
			}
			if !errors.Is(err, want) {
				t.Fatal("HTTP失敗を誤分類した")
			}
			if strings.Contains(err.Error(), testToken) || strings.Contains(err.Error(), endpoint) {
				t.Fatal("エラーへ資格または接続先を含めた")
			}
		})
	}
	if hits.Load() != 0 {
		t.Fatal("リダイレクト先へ接続した")
	}
}

func TestWSSMessageLimitsAndCancellation(t *testing.T) {
	for _, test := range []struct {
		name string
		kind websocket.MessageType
		body string
	}{
		{"binary", websocket.MessageBinary, "x"}, {"oversized", websocket.MessageText, strings.Repeat("x", 16385)},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, endpoint, roots := tlsEndpoint(t, func(w http.ResponseWriter, r *http.Request) {
				socket, err := websocket.Accept(w, r, nil)
				if err != nil {
					t.Error("Upgradeに失敗")
					return
				}
				defer closeTestSocket(t, socket)
				ctx, cancel := context.WithTimeout(context.Background(), time.Second*3)
				defer cancel()
				if err := socket.Write(ctx, test.kind, []byte(test.body)); err != nil {
					t.Error("拒否試験の送信に失敗")
				}
			})
			transport, err := NewWSS(endpoint, roots)
			if err != nil {
				t.Fatal(err)
			}
			socket, err := transport.Dial(context.Background(), testToken, testToken)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				// 拒否後のTLS切断で生じた解放エラーも、通信失敗として確認する。
				if err := socket.Close(); err != nil && !errors.Is(err, ErrTransport) {
					t.Error(err)
				}
			}()
			if _, err := socket.Read(context.Background()); !errors.Is(err, ErrProtocol) {
				t.Fatal("非テキストまたは過大メッセージを受理した")
			}
			if err := socket.Write(context.Background(), strings.Repeat("x", 16385)); !errors.Is(err, ErrProtocol) {
				t.Fatal("過大な送信を許可した")
			}
		})
	}
	_, endpoint, roots := tlsEndpoint(t, func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error("Upgradeに失敗")
			return
		}
		defer closeTestSocket(t, socket)
		if _, _, err := socket.Read(context.Background()); err == nil {
			t.Error("中断後も接続が残った")
		}
	})
	transport, err := NewWSS(endpoint, roots)
	if err != nil {
		t.Fatal(err)
	}
	socket, err := transport.Dial(context.Background(), testToken, testToken)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := socket.Close(); err != nil {
			t.Error(err)
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := socket.Read(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("読取を中断できない")
	}
}
