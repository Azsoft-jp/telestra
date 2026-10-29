// 固定HTTPS先からpolicyを読み、専用署名を検証する。HTTP失敗を録画認可の失効へ読み替えない。
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

// FetchedCapturePolicyの署名値はメモリで保持する。ログ・履歴・成果物へ書かない。
type FetchedCapturePolicy struct {
	Signed   string
	Verified wire.VerifiedCapturePolicy
}

// FetchCapturePolicyは既存の検証済み資格と端末鍵を使い、5秒・16KiB以内で取得する。
// 読取専用で自動再送せず、取得失敗から資格世代や録画許可を変更しない。
func (p *Provisioner) FetchCapturePolicy(ctx context.Context, recordingID string, verifier *wire.CapturePolicyV2Verifier, maxObservedTime int64) (output FetchedCapturePolicy, result error) {
	if ctx == nil || verifier == nil || !journalID.MatchString(recordingID) || p.config.Identity.Role != "tuner" {
		return output, ErrPolicy
	}
	p.mu.Lock()
	if p.policyFetching {
		p.mu.Unlock()
		return output, ErrPolicy
	}
	p.policyFetching = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.policyFetching = false; p.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return output, err
	}
	token, credential, err := p.Current()
	if err != nil {
		return output, err
	}
	challenge := "capture-policy.v2\x00" + recordingID + "\x00" + credential.TokenID
	proof, err := wire.SignProof(p.config.DeviceKey, p.config.DeviceKeyID, p.config.Identity, "capture-policy", challenge, p.now())
	if err != nil {
		return output, ErrCredentials
	}
	raw, err := json.Marshal(map[string]string{"recordingId": recordingID, "proof": proof})
	if err != nil || len(raw) > 8192 {
		return output, ErrProtocol
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.config.Endpoint+"/agent/capture-policy/v2", bytes.NewReader(raw))
	if err != nil {
		return output, ErrPolicy
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := p.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return output, ctx.Err()
		}
		return output, ErrTransport
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			result = errors.Join(result, ErrTransport)
			output = FetchedCapturePolicy{}
		}
	}()
	media, parameters, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != http.StatusOK || err != nil || media != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") || response.Header.Get("Content-Encoding") != "" || !strings.EqualFold(strings.TrimSpace(response.Header.Get("Cache-Control")), "no-store") || response.ContentLength > controlBytes {
		return output, ErrProtocol
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, controlBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return output, ctx.Err()
		}
		return output, ErrTransport
	}
	value, err := wire.Decode(body, controlBytes)
	if err != nil || wire.Validate("CapturePolicyResponse", value) != nil {
		return output, ErrProtocol
	}
	object, ok := value.(map[string]any)
	if !ok {
		return output, ErrProtocol
	}
	signed, ok := object["policy"].(string)
	if !ok {
		return output, ErrProtocol
	}
	verified, err := verifier.Verify(signed, p.config.Identity, p.now().Unix(), maxObservedTime)
	if err != nil || verified.Claims.RecordingID != recordingID {
		return output, ErrProtocol
	}
	return FetchedCapturePolicy{Signed: signed, Verified: verified}, nil
}
