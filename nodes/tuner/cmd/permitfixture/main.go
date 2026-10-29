// v2相互試験専用の固定IPC。合成鍵をメモリ内だけで扱い、通信・任意パス・Shell操作を持たない。
package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
	"io"
	"os"
)

type item struct {
	Token   string          `json:"token"`
	Context json.RawMessage `json:"context"`
}
type request struct {
	Issuer      string                   `json:"issuer"`
	Keys        []wire.PermitV2PublicKey `json:"keys"`
	Cases       []item                   `json:"cases"`
	PrivateSeed string                   `json:"privateSeed"`
	Claims      json.RawMessage          `json:"claims"`
}
type response struct {
	OK      bool     `json:"ok"`
	Results []string `json:"results,omitempty"`
	Signed  string   `json:"signed,omitempty"`
}

// 入力を1MiB、件数を128件へ制限し、失敗時も鍵・Token・元のエラーを返さない。
func run() response {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1048577))
	if err != nil || len(raw) > 1048576 {
		return response{}
	}
	if _, err := wire.Decode(raw, 1048576); err != nil {
		return response{}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var input request
	if decoder.Decode(&input) != nil || len(input.Cases) > 128 {
		return response{}
	}
	verifier, err := wire.NewCapturePermitV2Verifier(input.Issuer, input.Keys)
	if err != nil {
		return response{}
	}
	result := response{OK: true}
	for _, item := range input.Cases {
		value, err := wire.Decode(item.Context, 8192)
		if err != nil || wire.Validate("CapturePermitV2Context", value) != nil {
			result.Results = append(result.Results, "rejected")
			continue
		}
		var context wire.PermitV2Context
		if json.Unmarshal(item.Context, &context) != nil {
			result.Results = append(result.Results, "rejected")
			continue
		}
		verified, err := verifier.Verify(item.Token, context)
		state := "rejected"
		if err == nil && !verified.ExecutionAuthorized {
			state = verified.Window
		}
		result.Results = append(result.Results, state)
	}
	if input.PrivateSeed != "" {
		// 合成鍵の種だけをIPCから受け、受信したclaimsのバイト列をGo標準実装で署名する。
		seed, err := base64.RawURLEncoding.Strict().DecodeString(input.PrivateSeed)
		value, parseErr := wire.Decode(input.Claims, 8192)
		if err != nil || len(seed) != 32 || parseErr != nil || wire.Validate("CapturePermitV2", value) != nil {
			return response{}
		}
		key := ed25519.NewKeyFromSeed(seed)
		if base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey)) != input.Keys[0].X {
			return response{}
		}
		header, err := json.Marshal(map[string]string{"alg": "Ed25519", "typ": "telestra-capture-permit-v2+jwt", "kid": input.Keys[0].Kid})
		if err != nil {
			return response{}
		}
		signing := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(input.Claims)
		result.Signed = signing + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(signing)))
		if len(result.Signed) > 8192 {
			return response{}
		}
	}
	return result
}
func main() {
	// 応答も親プロセスのメモリだけで扱う。出力失敗に入力や秘密値を含めない。
	encoded, err := json.Marshal(run())
	if err != nil {
		os.Exit(1)
	}
	if _, err = fmt.Fprintln(os.Stdout, string(encoded)); err != nil {
		os.Exit(1)
	}
}
