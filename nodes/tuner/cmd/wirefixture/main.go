// プロセス間の契約試験専用。固定した署名処理だけを行い、通信・Shell・任意パス操作を持たない。
package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

type request struct {
	Mode        string           `json:"mode"`
	Definition  string           `json:"definition"`
	Value       json.RawMessage  `json:"value"`
	Issuer      string           `json:"issuer"`
	Keys        []wire.PublicJWK `json:"keys"`
	Identity    wire.Identity    `json:"identity"`
	Credential  string           `json:"credential"`
	Now         int64            `json:"now"`
	LastEpoch   int64            `json:"lastEpoch"`
	Messages    []string         `json:"messages"`
	PrivateSeed string           `json:"privateSeed"`
	DeviceKid   string           `json:"deviceKid"`
}
type response struct {
	OK        bool   `json:"ok"`
	Valid     bool   `json:"valid,omitempty"`
	Code      string `json:"code,omitempty"`
	Proof     string `json:"proof,omitempty"`
	Hello     string `json:"hello,omitempty"`
	Heartbeat string `json:"heartbeat,omitempty"`
	Ack       string `json:"ack,omitempty"`
}

// 鍵・Tokenは標準入力と応答のIPCだけで受け渡し、失敗時に入力を表示しない。
func run() response {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 131073))
	if err != nil || len(raw) > 131072 {
		return response{Code: "INVALID"}
	}
	if _, err := wire.Decode(raw, 131072); err != nil {
		return response{Code: "INVALID"}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var input request
	if err := decoder.Decode(&input); err != nil {
		return response{Code: "INVALID"}
	}
	if input.Mode == "validate" {
		value, err := wire.Decode(input.Value, 16384)
		valid := err == nil && wire.Validate(input.Definition, value) == nil
		return response{OK: true, Valid: valid}
	}
	if input.Mode != "exchange" || len(input.Messages) > 32 || input.Now < 0 {
		return response{Code: "INVALID"}
	}
	verifier, err := wire.NewVerifier(input.Issuer, input.Keys)
	if err != nil {
		return response{Code: "INVALID"}
	}
	now := time.Unix(input.Now, 0)
	credential, err := verifier.VerifyCredential(input.Credential, input.Identity, now)
	if err != nil {
		return response{Code: "INVALID"}
	}
	seed, err := base64.RawURLEncoding.Strict().DecodeString(input.PrivateSeed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return response{Code: "INVALID"}
	}
	key := ed25519.NewKeyFromSeed(seed)
	proof, err := wire.SignProof(key, input.DeviceKid, input.Identity, "connect", credential.TokenID, now)
	if err != nil {
		return response{Code: "INVALID"}
	}
	output := response{OK: true, Proof: proof}
	if len(input.Messages) == 0 {
		return output
	}
	channel, _, err := verifier.VerifyWelcome(input.Messages[0], credential, input.LastEpoch, now)
	if err != nil {
		return response{Code: "INVALID"}
	}
	backend := "synthetic"
	capabilities := []string{"capture", "epg-read"}
	if credential.Role == "encoder" {
		backend = "encoder"
		capabilities = []string{"mock-encode"}
	}
	output.Hello, err = wire.SignEvent(key, input.DeviceKid, channel, "node.hello", map[string]any{"agentVersion": "go-phase01-fixture", "nodeRole": credential.Role, "backend": backend, "capabilities": capabilities, "maxConcurrentJobs": 1}, "", now)
	if err != nil {
		return response{Code: "INVALID"}
	}
	output.Heartbeat, err = wire.SignEvent(key, input.DeviceKid, channel, "node.heartbeat", map[string]any{"uptimeSeconds": 1, "spoolBytes": 0}, "", now)
	if err != nil {
		return response{Code: "INVALID"}
	}
	for _, message := range input.Messages[1:] {
		envelope, err := verifier.VerifyControl(message, channel, now)
		if err != nil {
			return response{Code: "INVALID"}
		}
		if envelope.Kind == "command" {
			// 媒体処理を実行せず、未実装という応答だけを署名する。
			output.Ack, err = wire.SignEvent(key, input.DeviceKid, channel, "command.ack", map[string]any{"accepted": false, "code": "not implemented"}, envelope.MessageID, now)
			if err != nil {
				return response{Code: "INVALID"}
			}
		}
	}
	return output
}
func main() {
	if err := json.NewEncoder(os.Stdout).Encode(run()); err != nil {
		if _, err := fmt.Fprintln(os.Stderr, "契約試験の応答を出力できません。"); err != nil {
			os.Exit(2)
		}
		os.Exit(1)
	}
}
