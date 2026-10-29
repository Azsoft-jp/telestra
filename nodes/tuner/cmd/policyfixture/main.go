// policy相互試験専用。鍵とJWSはIPCだけで扱い、通信はloopback TLSに限定する。
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/control"
	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

type testCase struct {
	Policy      string `json:"policy"`
	Permit      string `json:"permit"`
	Now         int64  `json:"now"`
	MaxObserved int64  `json:"maxObserved"`
}
type request struct {
	Mode        string                   `json:"mode"`
	Issuer      string                   `json:"issuer"`
	PolicyKeys  []wire.PermitV2PublicKey `json:"policyKeys"`
	PermitKeys  []wire.PermitV2PublicKey `json:"permitKeys"`
	ControlKeys []wire.PublicJWK         `json:"controlKeys"`
	Identity    wire.Identity            `json:"identity"`
	MaxLifetime int64                    `json:"maxLifetime"`
	Cases       []testCase               `json:"cases"`
	Endpoint    string                   `json:"endpoint"`
	RootPEM     string                   `json:"rootPEM"`
	PrivateSeed string                   `json:"privateSeed"`
	DeviceKeyID string                   `json:"deviceKeyID"`
	Credential  string                   `json:"credential"`
	RecordingID string                   `json:"recordingId"`
}
type response struct {
	OK                  bool     `json:"ok"`
	Results             []string `json:"results,omitempty"`
	AuthorizationEpoch  int64    `json:"authorizationEpoch,omitempty"`
	AssignmentEpoch     int64    `json:"assignmentEpoch,omitempty"`
	Revoked             bool     `json:"revoked"`
	ExecutionAuthorized bool     `json:"executionAuthorized"`
}

// 固定したモードだけを扱い、失敗内容へ入力値を含めない。
func run() (output response, resultErr error) {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1048577))
	if err != nil || len(raw) > 1048576 {
		return response{}, control.ErrProtocol
	}
	if _, err := wire.Decode(raw, 1048576); err != nil {
		return response{}, control.ErrProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var input request
	if decoder.Decode(&input) != nil || len(input.Cases) > 128 {
		return response{}, control.ErrProtocol
	}
	policy, err := wire.NewCapturePolicyV2Verifier(input.Issuer, input.PolicyKeys, input.MaxLifetime)
	if err != nil {
		return response{}, err
	}
	if input.Mode == "verify" {
		permit, err := wire.NewCapturePermitV2Verifier(input.Issuer, input.PermitKeys)
		if err != nil {
			return response{}, err
		}
		result := response{OK: true}
		for _, item := range input.Cases {
			state := "rejected"
			verified, err := policy.VerifyPermit(item.Policy, item.Permit, permit, input.Identity, item.Now, item.MaxObserved)
			if err == nil && !verified.ExecutionAuthorized {
				state = verified.Window
			}
			result.Results = append(result.Results, state)
		}
		return result, nil
	}
	if input.Mode != "fetch" {
		return response{}, control.ErrPolicy
	}
	endpoint, err := url.Parse(input.Endpoint)
	if err != nil || endpoint.Scheme != "https" || !net.ParseIP(endpoint.Hostname()).IsLoopback() {
		return response{}, control.ErrPolicy
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(input.RootPEM)) {
		return response{}, control.ErrPolicy
	}
	seed, err := base64.RawURLEncoding.Strict().DecodeString(input.PrivateSeed)
	if err != nil || len(seed) != 32 {
		return response{}, control.ErrCredentials
	}
	key := ed25519.NewKeyFromSeed(seed)
	credentialVerifier, err := wire.NewVerifier(input.Issuer, input.ControlKeys)
	if err != nil {
		return response{}, err
	}
	directory, err := os.MkdirTemp("", "telestra-policy-fixture-")
	if err != nil {
		return response{}, control.ErrJournal
	}
	defer func() {
		if err := os.RemoveAll(directory); err != nil {
			output = response{}
			resultErr = control.ErrJournal
		}
	}()
	journal, err := control.OpenJournal(directory, input.Identity, 8)
	if err != nil {
		return response{}, err
	}
	defer func() {
		if err := journal.Close(); err != nil {
			output = response{}
			resultErr = control.ErrJournal
		}
	}()
	transport, err := control.NewWSS("wss://"+endpoint.Host+"/agent", roots)
	if err != nil {
		return response{}, err
	}
	// 空の履歴への直接設定は既存の初回bootstrapだけを使い、確認hash以外は保存しない。
	_, err = control.NewClient(control.ClientConfig{Transport: transport, Verifier: credentialVerifier, Identity: input.Identity, Credential: input.Credential, DeviceKey: key, DeviceKeyID: input.DeviceKeyID, Journal: journal, AgentVersion: "policy-fixture"})
	if err != nil {
		return response{}, err
	}
	provisioner, err := control.NewProvisioner(control.ProvisionConfig{Endpoint: strings.TrimSuffix(input.Endpoint, "/"), Roots: roots, Verifier: credentialVerifier, Identity: input.Identity, DeviceKey: key, DeviceKeyID: input.DeviceKeyID, Journal: journal})
	if err != nil {
		return response{}, err
	}
	defer provisioner.Close()
	if err := provisioner.RestoreCredential(input.Credential); err != nil {
		return response{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	fetched, err := provisioner.FetchCapturePolicy(ctx, input.RecordingID, policy, 0)
	if err != nil {
		return response{}, err
	}
	return response{OK: true, AuthorizationEpoch: fetched.Verified.Claims.AuthorizationEpoch, AssignmentEpoch: fetched.Verified.Claims.AssignmentEpoch, Revoked: fetched.Verified.Claims.Revoked, ExecutionAuthorized: fetched.Verified.ExecutionAuthorized}, nil
}
func main() {
	result, err := run()
	if err != nil {
		result = response{}
	}
	// 診断には合否と非秘密の世代だけを返し、資格・JWS・元のエラーを出力しない。
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(1)
	}
}
