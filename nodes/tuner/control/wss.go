// WSSの通信境界を固定する。認証情報をURLへ含めず、転送と制御を分離する。
package control

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

var ErrTransport = errors.New("制御サーバーとの通信が切断されました")
var compactJWS = regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)

const controlBytes = 16384

// WSSは設定済みの単一接続先だけを使う。受信したURLによる接続先変更は行わない。
type WSS struct {
	endpoint string
	client   *http.Client
}

// NewWSSは通常の証明書検証を維持する。rootsは専用CAを明示する場合だけ設定する。
func NewWSS(endpoint string, roots *x509.CertPool) (*WSS, error) {
	if ValidateEndpoint(endpoint) != nil {
		return nil, ErrProtocol
	}
	if roots != nil {
		roots = roots.Clone()
	}
	transport := &http.Transport{
		DialContext:            (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  10 * time.Second,
		MaxResponseHeaderBytes: 16384,
	}
	return &WSS{endpoint, &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Socketは最大16KiBのテキストだけを扱う。Tokenを含むライブラリエラーは外へ返さない。
type Socket struct{ connection *websocket.Conn }

// Dialは用途別のTokenをヘッダーへ渡し、Origin、Cookie、圧縮を追加しない。
// 署名・用途・期限の検証と接続証明の作成はClientで接続前に行う。
func (w *WSS) Dial(ctx context.Context, credential, proof string) (*Socket, error) {
	if ctx == nil || len(credential) > 8192 || len(proof) > 8192 || !compactJWS.MatchString(credential) || !compactJWS.MatchString(proof) {
		return nil, ErrCredentials
	}
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(deadline, w.endpoint, &websocket.DialOptions{
		HTTPClient: w.client, HTTPHeader: http.Header{"Authorization": {"Bearer " + credential}, "X-Tv-Device-Proof": {proof}}, CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if response != nil {
			switch response.StatusCode {
			case 401, 403:
				return nil, ErrCredentials
			case 408, 429, 500, 502, 503, 504:
				return nil, ErrTransport
			default:
				return nil, ErrProtocol
			}
		}
		// 未信頼証明書やホスト名不一致では資格を更新せず、同じ接続を繰り返さない。
		var certificate *tls.CertificateVerificationError
		if errors.As(err, &certificate) {
			return nil, ErrProtocol
		}
		return nil, ErrTransport
	}
	connection.SetReadLimit(controlBytes)
	return &Socket{connection}, nil
}

// Readはバイナリと過大メッセージを拒否し、Contextで待機を中断できる。
func (s *Socket) Read(ctx context.Context) (string, error) {
	typeName, body, err := s.connection.Read(ctx)
	if err != nil {
		return "", socketError(ctx, err)
	}
	if typeName != websocket.MessageText || !utf8.Valid(body) || len(body) > controlBytes {
		return "", ErrProtocol
	}
	return string(body), nil
}

// Writeはサイズを送信前にも検査し、低速な相手への待機を最大5秒に限る。
func (s *Socket) Write(ctx context.Context, value string) error {
	if value == "" || len(value) > controlBytes || !utf8.ValidString(value) {
		return ErrProtocol
	}
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := s.connection.Write(deadline, websocket.MessageText, []byte(value)); err != nil {
		return socketError(ctx, err)
	}
	return nil
}

// Closeは終了を待つ追加のハンドシェイクを省き、既に閉じた接続の解放を冪等にする。
func (s *Socket) Close() error {
	if err := s.connection.CloseNow(); err != nil && !errors.Is(err, net.ErrClosed) {
		return ErrTransport
	}
	return nil
}

// 切断理由の自由文は転記しない。認証・形式違反だけを再試行しない失敗へ分類する。
func socketError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, websocket.ErrMessageTooBig) {
		return ErrProtocol
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusPolicyViolation, 4001, 4003:
		return ErrCredentials
	case websocket.StatusProtocolError, websocket.StatusUnsupportedData, websocket.StatusInvalidFramePayloadData, websocket.StatusMessageTooBig, 4002:
		return ErrProtocol
	default:
		return ErrTransport
	}
}
