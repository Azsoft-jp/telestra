// 署名検証、永続履歴、WSSを結ぶ。Phase 01では媒体操作を実装せず、未実装と応答する。
package control

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

// ClientConfigは呼出元が管理する固定構成である。受信データから鍵や接続先を変更しない。
// この段階ではdevelopmentと合成Backendだけを許可し、実録画の能力を広告しない。
type ClientConfig struct {
	Transport    *WSS
	Verifier     *wire.Verifier
	Identity     wire.Identity
	Credential   string
	DeviceKey    ed25519.PrivateKey
	DeviceKeyID  string
	Journal      *Journal
	AgentVersion string
}

// Clientは一つの履歴を共有する。1インスタンスで複数の接続を並行稼働させない。
type Client struct {
	config  ClientConfig
	mu      sync.Mutex
	active  bool
	started time.Time
	now     func() time.Time
}

// NewClientは初期設定と資格を検証する。鍵はコピーし、資格と秘密鍵をファイルへ保存しない。
func NewClient(config ClientConfig) (*Client, error) {
	if config.Transport == nil || config.Verifier == nil || config.Journal == nil || len(config.DeviceKey) != ed25519.PrivateKeySize || config.Identity.Environment != "development" {
		return nil, ErrPolicy
	}
	config.Journal.mu.Lock()
	validJournal := !config.Journal.closed && !config.Journal.faulty && config.Journal.data.Identity == config.Identity
	config.Journal.mu.Unlock()
	if !validJournal {
		return nil, errors.Join(ErrProtocol, ErrJournal)
	}
	now := time.Now()
	credential, err := config.Verifier.VerifyCredential(config.Credential, config.Identity, now)
	if err != nil {
		return nil, ErrCredentials
	}
	if _, err := wire.SignProof(config.DeviceKey, config.DeviceKeyID, config.Identity, "connect", credential.TokenID, now); err != nil {
		return nil, ErrCredentials
	}
	config.DeviceKey = append(ed25519.PrivateKey(nil), config.DeviceKey...)
	client := &Client{config: config, started: now, now: time.Now}
	if _, err := client.hello(0); err != nil {
		return nil, ErrPolicy
	}
	return client, nil
}

func (c *Client) hello(epoch int64) (map[string]any, error) {
	backend := "synthetic"
	if c.config.Identity.Role == "encoder" {
		backend = "encoder"
	}
	value := map[string]any{"agentVersion": c.config.AgentVersion, "nodeRole": c.config.Identity.Role, "backend": backend, "capabilities": []string{}, "maxConcurrentJobs": 0}
	if epoch > 0 {
		value["resume"] = map[string]any{"lastSessionEpoch": epoch}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, ErrProtocol
	}
	decoded, err := wire.Decode(raw, controlBytes)
	if err != nil || wire.Validate("WsHello", decoded) != nil {
		return nil, ErrProtocol
	}
	return value, nil
}

// Dialは資格を再検査し、接続ごとに新しい端末証明を作る。
// 接続世代を保存し、helloの受領通知を確認してからRunnerへ接続を返す。
func (c *Client) Dial(ctx context.Context) (session Session, result error) {
	if ctx == nil {
		return nil, ErrPolicy
	}
	c.mu.Lock()
	if c.active {
		c.mu.Unlock()
		return nil, ErrPolicy
	}
	c.active = true
	c.mu.Unlock()
	var socket *Socket
	defer func() {
		if result != nil {
			if socket != nil {
				result = errors.Join(result, socket.Close())
			}
			c.release()
		}
	}()
	credential, err := c.config.Verifier.VerifyCredential(c.config.Credential, c.config.Identity, c.now())
	if err != nil {
		return nil, ErrCredentials
	}
	proof, err := wire.SignProof(c.config.DeviceKey, c.config.DeviceKeyID, c.config.Identity, "connect", credential.TokenID, c.now())
	if err != nil {
		return nil, ErrCredentials
	}
	lastEpoch, err := c.config.Journal.LastEpoch()
	if err != nil {
		return nil, errors.Join(ErrProtocol, err)
	}
	socket, err = c.config.Transport.Dial(ctx, c.config.Credential, proof)
	if err != nil {
		return nil, err
	}
	handshake, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, err := socket.Read(handshake)
	if err != nil {
		return nil, err
	}
	channel, _, err := c.config.Verifier.VerifyWelcome(raw, credential, lastEpoch, c.now())
	if err != nil {
		return nil, ErrProtocol
	}
	if err := c.config.Journal.AdvanceEpoch(channel.Epoch); err != nil {
		return nil, errors.Join(ErrProtocol, err)
	}
	hello, err := c.hello(lastEpoch)
	if err != nil {
		return nil, err
	}
	event, err := wire.PrepareEvent(c.config.DeviceKey, c.config.DeviceKeyID, channel, "node.hello", hello, "", c.now())
	if err != nil {
		return nil, ErrProtocol
	}
	if err := socket.Write(handshake, event.Token); err != nil {
		return nil, err
	}
	raw, err = socket.Read(handshake)
	if err != nil {
		return nil, err
	}
	receipt, err := c.config.Verifier.VerifyControl(raw, channel, c.now())
	if err != nil || receipt.Type != "control.receipt" || receipt.Payload["messageId"] != event.MessageID {
		return nil, ErrProtocol
	}
	return &clientSession{client: c, socket: socket, channel: channel}, nil
}

func (c *Client) release() { c.mu.Lock(); defer c.mu.Unlock(); c.active = false }

type clientSession struct {
	client     *Client
	socket     *Socket
	channel    wire.Channel
	closeOnce  sync.Once
	closeError error
	serveOnce  sync.Once
}
type received struct {
	raw string
	err error
}

// Serveは1回だけ実行し、読取goroutineを回収してから戻る。
func (s *clientSession) Serve(ctx context.Context) error {
	if ctx == nil {
		return ErrPolicy
	}
	result := ErrProtocol
	s.serveOnce.Do(func() { result = s.serve(ctx) })
	return result
}

func (s *clientSession) serve(parent context.Context) (result error) {
	ctx, cancel := context.WithDeadline(parent, time.Unix(s.channel.Credential.ExpiresAt, 0))
	defer cancel()
	inbox := make(chan received, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			deadline, stop := context.WithTimeout(ctx, 45*time.Second)
			raw, err := s.socket.Read(deadline)
			stop()
			select {
			case inbox <- received{raw, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() {
		cancel()
		result = errors.Join(result, s.Close())
		<-done
	}()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	check := time.NewTicker(time.Second)
	defer check.Stop()
	pending := map[string]int64{}
	send := func(typeName string, payload map[string]any, correlationID string) error {
		if len(pending) >= 8 {
			return ErrProtocol
		}
		event, err := wire.PrepareEvent(s.client.config.DeviceKey, s.client.config.DeviceKeyID, s.channel, typeName, payload, correlationID, s.client.now())
		if err != nil {
			return ErrProtocol
		}
		if err := s.socket.Write(ctx, event.Token); err != nil {
			return err
		}
		pending[event.MessageID] = event.ExpiresAt
		return nil
	}
	for {
		// 通知が届き続けても受領待ちの期限と資格期限を延長しない。
		now := s.client.now()
		if now.Unix() >= s.channel.Credential.ExpiresAt {
			return ErrCredentials
		}
		for _, expiry := range pending {
			if expiry <= now.Unix() {
				return ErrTransport
			}
		}
		select {
		case <-ctx.Done():
			if parent.Err() != nil {
				return parent.Err()
			}
			return ErrCredentials
		case <-check.C:
			continue
		case <-ticker.C:
			uptime := int64(s.client.now().Sub(s.client.started) / time.Second)
			if uptime < 0 {
				return ErrProtocol
			}
			if err := send("node.heartbeat", map[string]any{"uptimeSeconds": uptime, "spoolBytes": 0}, ""); err != nil {
				return err
			}
		case input := <-inbox:
			if input.err != nil {
				if parent.Err() != nil {
					return parent.Err()
				}
				if s.client.now().Unix() >= s.channel.Credential.ExpiresAt {
					return ErrCredentials
				}
				return input.err
			}
			envelope, err := s.client.config.Verifier.VerifyControl(input.raw, s.channel, s.client.now())
			if err != nil {
				return ErrProtocol
			}
			if envelope.Type == "control.receipt" {
				id, ok := envelope.Payload["messageId"].(string)
				if !ok || pending[id] == 0 {
					return ErrProtocol
				}
				delete(pending, id)
				continue
			}
			// 実際の録画開始やPermit内部の暗号検証はPhase 02へ残す。
			// 履歴の確定を経たnot implementedだけを返し、録画成功を装わない。
			outcome, _, err := s.client.config.Journal.Execute(envelope, s.client.now(), func(wire.Envelope) (Result, error) { return Result{Code: "not implemented"}, nil })
			if err != nil {
				return errors.Join(ErrProtocol, err)
			}
			if err := send("command.ack", map[string]any{"accepted": outcome.Accepted, "code": outcome.Code}, envelope.MessageID); err != nil {
				return err
			}
		}
	}
}

// Closeは接続を解放する。資格と履歴は削除せず、次の試行へ引き継ぐ。
func (s *clientSession) Close() error {
	s.closeOnce.Do(func() { s.closeError = s.socket.Close(); s.client.release() })
	return s.closeError
}
