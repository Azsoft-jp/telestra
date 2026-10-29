// 制御メッセージを資格と接続世代へ拘束し、型付き制御と媒体処理を分離する。
package wire

import (
	"crypto/ed25519"
	"encoding/json"
	"time"
)

// EnvelopeはSchema検証後の本文だけを表す。Payloadを任意コマンドとして実行しない。
type Envelope struct {
	MessageID     string
	Kind          string
	Type          string
	NodeID        string
	Epoch         int64
	IssuedAt      int64
	ExpiresAt     int64
	CorrelationID string
	Payload       map[string]any
}
type Channel struct {
	Credential Credential
	Epoch      int64
}

var payloadDefinitions = map[string]string{"session.ready": "WsSessionReady", "node.hello": "WsHello", "node.heartbeat": "WsHeartbeat", "capture.start": "WsCaptureStart", "capture.cancel": "WsCaptureCancel", "command.ack": "WsCommandAck", "control.receipt": "WsReceipt"}

// VerifyWelcomeは署名済みの接続世代を取得し、保存済み世代以下への巻き戻りを拒否する。
func (v *Verifier) VerifyWelcome(raw string, credential Credential, lastEpoch int64, now time.Time) (Channel, Envelope, error) {
	envelope, err := v.verifyControl(raw, credential, now)
	if err != nil || envelope.Type != "session.ready" || envelope.Epoch <= lastEpoch {
		return Channel{}, Envelope{}, ErrInvalid
	}
	return Channel{Credential: credential, Epoch: envelope.Epoch}, envelope, nil
}

// VerifyControlは受信方向と現在の接続世代を確認し、Nodeからのイベントをサーバー命令として受け付けない。
func (v *Verifier) VerifyControl(raw string, channel Channel, now time.Time) (Envelope, error) {
	envelope, err := v.verifyControl(raw, channel.Credential, now)
	if err != nil || envelope.Epoch != channel.Epoch || (envelope.Type != "control.receipt" && envelope.Type != "capture.start" && envelope.Type != "capture.cancel") || (envelope.Kind == "command" && channel.Credential.Role != "tuner") {
		return Envelope{}, ErrInvalid
	}
	return envelope, nil
}
func (v *Verifier) verifyControl(raw string, credential Credential, now time.Time) (Envelope, error) {
	if !credential.Identity.valid() || credential.Version < 1 || credential.ExpiresAt <= now.Unix() {
		return Envelope{}, ErrInvalid
	}
	claims, err := v.verify(raw, "tv-control+jwt", "ControlClaims", "tv-node-control", 30, now)
	if err != nil || text(claims, "sub") != credential.NodeID || text(claims, "nodeId") != credential.NodeID || text(claims, "tenantId") != credential.TenantID || text(claims, "environment") != credential.Environment || text(claims, "direction") != "control-to-node" || integer(claims, "credentialVersion") != credential.Version || integer(claims, "exp") > credential.ExpiresAt {
		return Envelope{}, ErrInvalid
	}
	object, ok := claims["envelope"].(map[string]any)
	if !ok {
		return Envelope{}, ErrInvalid
	}
	envelope, err := parseEnvelope(object, now)
	if err != nil || envelope.NodeID != credential.NodeID || envelope.MessageID != text(claims, "jti") || envelope.IssuedAt != integer(claims, "iat") || envelope.ExpiresAt != integer(claims, "exp") {
		return Envelope{}, ErrInvalid
	}
	return envelope, nil
}
func parseEnvelope(object map[string]any, now time.Time) (Envelope, error) {
	if Validate("WsEnvelope", object) != nil {
		return Envelope{}, ErrInvalid
	}
	typeName := text(object, "type")
	definition := payloadDefinitions[typeName]
	payload, ok := object["payload"].(map[string]any)
	if !ok || definition == "" || Validate(definition, payload) != nil {
		return Envelope{}, ErrInvalid
	}
	kind := "event"
	if typeName == "command.ack" {
		kind = "ack"
	} else if typeName == "capture.start" || typeName == "capture.cancel" {
		kind = "command"
	}
	_, hasCorrelation := object["correlationId"]
	issued, ie := dateTime(text(object, "issuedAt"))
	expires, ee := dateTime(text(object, "expiresAt"))
	if ie != nil || ee != nil || issued.Nanosecond() != 0 || expires.Nanosecond() != 0 || issued.Unix() > now.Unix() || expires.Unix() <= now.Unix() || expires.Unix() <= issued.Unix() || expires.Unix()-issued.Unix() > 30 || text(object, "kind") != kind || (typeName == "command.ack") != hasCorrelation {
		return Envelope{}, ErrInvalid
	}
	if typeName == "command.ack" {
		accepted, _ := payload["accepted"].(bool)
		if accepted != (text(payload, "code") == "accepted") {
			return Envelope{}, ErrInvalid
		}
	}
	if typeName == "capture.start" {
		permit, ok := payload["permit"].(map[string]any)
		if !ok {
			return Envelope{}, ErrInvalid
		}
		claims, ok := permit["claims"].(map[string]any)
		if !ok || text(claims, "nodeId") != text(object, "nodeId") || text(claims, "captureScope") == "" {
			return Envelope{}, ErrInvalid
		}
	}
	return Envelope{MessageID: text(object, "messageId"), Kind: kind, Type: typeName, NodeID: text(object, "nodeId"), Epoch: integer(object, "sessionEpoch"), IssuedAt: issued.Unix(), ExpiresAt: expires.Unix(), CorrelationID: text(object, "correlationId"), Payload: payload}, nil
}

// PreparedEventは送信したイベントと受領通知の照合に使う。Tokenをログへ出力しない。
type PreparedEvent struct {
	Token     string
	MessageID string
	ExpiresAt int64
}

// SignEventは署名だけを必要とする既存の呼出元に使用する。
func SignEvent(key ed25519.PrivateKey, kid string, channel Channel, typeName string, payload map[string]any, correlationID string, now time.Time) (string, error) {
	event, err := PrepareEvent(key, kid, channel, typeName, payload, correlationID, now)
	return event.Token, err
}

// PrepareEventはNodeから許可されたイベントだけを署名し、受領通知と照合するIDと期限を返す。
func PrepareEvent(key ed25519.PrivateKey, kid string, channel Channel, typeName string, payload map[string]any, correlationID string, now time.Time) (PreparedEvent, error) {
	if !channel.Credential.Identity.valid() || channel.Epoch < 1 || channel.Credential.ExpiresAt <= now.Unix() || (typeName != "node.hello" && typeName != "node.heartbeat" && typeName != "command.ack") {
		return PreparedEvent{}, ErrInvalid
	}
	id, err := messageID()
	if err != nil {
		return PreparedEvent{}, err
	}
	expires := now.Unix() + 30
	if expires > channel.Credential.ExpiresAt {
		expires = channel.Credential.ExpiresAt
	}
	kind := "event"
	if typeName == "command.ack" {
		kind = "ack"
	}
	object := map[string]any{"protocolVersion": 1, "messageId": id, "kind": kind, "type": typeName, "nodeId": channel.Credential.NodeID, "sessionEpoch": channel.Epoch, "issuedAt": now.UTC().Truncate(time.Second).Format(time.RFC3339Nano), "expiresAt": time.Unix(expires, 0).UTC().Format(time.RFC3339Nano), "payload": payload}
	if correlationID != "" {
		object["correlationId"] = correlationID
	}
	raw, err := json.Marshal(object)
	if err != nil {
		return PreparedEvent{}, ErrInvalid
	}
	decoded, err := Decode(raw, 16384)
	if err != nil {
		return PreparedEvent{}, ErrInvalid
	}
	validated, ok := decoded.(map[string]any)
	if !ok {
		return PreparedEvent{}, ErrInvalid
	}
	if _, err := parseEnvelope(validated, now); err != nil {
		return PreparedEvent{}, err
	}
	claims := map[string]any{"iss": channel.Credential.NodeID, "aud": "tv-control-plane", "sub": channel.Credential.NodeID, "iat": now.Unix(), "exp": expires, "jti": id, "tenantId": channel.Credential.TenantID, "environment": channel.Credential.Environment, "nodeId": channel.Credential.NodeID, "credentialVersion": channel.Credential.Version, "direction": "node-to-control", "envelope": object}
	signed, err := sign(key, kid, "tv-control+jwt", "ControlClaims", claims)
	if err != nil {
		return PreparedEvent{}, err
	}
	return PreparedEvent{Token: signed, MessageID: id, ExpiresAt: expires}, nil
}
