// ローカルWorkerとのWSS相互試験専用。試験用の資格と鍵はIPCだけで受け渡す。
// 本番の起動コマンドではなく、ループバック以外への接続と実録画を拒否する。
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/control"
	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

type request struct {
	Mode        string           `json:"mode"`
	Endpoint    string           `json:"endpoint"`
	RootPEM     string           `json:"rootPEM"`
	Issuer      string           `json:"issuer"`
	Keys        []wire.PublicJWK `json:"keys"`
	Identity    wire.Identity    `json:"identity"`
	Credential  string           `json:"credential"`
	JoinCode    string           `json:"joinCode"`
	PrivateSeed string           `json:"privateSeed"`
	DeviceKeyID string           `json:"deviceKeyID"`
}

// 出力先は親試験のパイプに限る。送受信したJWSやライブラリエラーをログへ出さない。
var outputMu sync.Mutex

func emit(value any) error {
	outputMu.Lock()
	defer outputMu.Unlock()
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		return control.ErrProtocol
	}
	return nil
}

// TLS鍵と証明書は試験中にだけ作り、ファイル、ログ、証跡へ保存しない。
func tlsMaterial() error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return control.ErrProtocol
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return control.ErrProtocol
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "TV local WSS fixture"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, BasicConstraintsValid: true, IsCA: true, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
	certificate, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return control.ErrProtocol
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return control.ErrProtocol
	}
	return emit(map[string]string{"certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}))})
}

// 入力はサイズ・重複キー・未知フィールドを検査し、接続先を数値のloopbackへ限定する。
func run() (result error) {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 131073))
	if err != nil || len(raw) > 131072 {
		return control.ErrProtocol
	}
	if _, err := wire.Decode(raw, 131072); err != nil {
		return control.ErrProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var input request
	if err := decoder.Decode(&input); err != nil {
		return control.ErrProtocol
	}
	if input.Mode == "tls-material" {
		return tlsMaterial()
	}
	endpoint, err := url.Parse(input.Endpoint)
	if err != nil || (input.Mode != "run" && input.Mode != "provision-run") || !net.ParseIP(endpoint.Hostname()).IsLoopback() || endpoint.Port() == "" || len(input.RootPEM) > 8192 {
		return control.ErrProtocol
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(input.RootPEM)) {
		return control.ErrProtocol
	}
	transport, err := control.NewWSS(input.Endpoint, roots)
	if err != nil {
		return err
	}
	verifier, err := wire.NewVerifier(input.Issuer, input.Keys)
	if err != nil {
		return control.ErrProtocol
	}
	seed, err := base64.RawURLEncoding.Strict().DecodeString(input.PrivateSeed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return control.ErrCredentials
	}
	directory, err := os.MkdirTemp("", "tv-go-control-")
	if err != nil {
		return control.ErrJournal
	}
	defer func() {
		if err := os.RemoveAll(directory); err != nil {
			result = errors.Join(result, control.ErrJournal)
		}
	}()
	journal, err := control.OpenJournal(filepath.Join(directory, "agent-state"), input.Identity, 32)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, journal.Close()) }()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if input.Mode == "provision-run" {
		// 管理者は公開鍵登録と参加権利の発行だけを担当し、join/rotateの署名とHTTP通信はGoで行う。
		if input.Credential != "" {
			return control.ErrProtocol
		}
		provisioner, err := control.NewProvisioner(control.ProvisionConfig{Endpoint: "https://" + endpoint.Host, Roots: roots, Verifier: verifier, Identity: input.Identity, DeviceKey: ed25519.NewKeyFromSeed(seed), DeviceKeyID: input.DeviceKeyID})
		if err != nil {
			return err
		}
		defer provisioner.Close()
		if err := provisioner.Join(ctx, input.JoinCode); err != nil {
			return err
		}
		_, joined, err := provisioner.Current()
		if err != nil {
			return err
		}
		if err := emit(map[string]any{"state": "joined", "generation": joined.Version}); err != nil {
			return err
		}
		if err := provisioner.Rotate(ctx); err != nil {
			return err
		}
		credential, claims, err := provisioner.Current()
		if err != nil {
			return err
		}
		input.Credential = credential
		if err := emit(map[string]any{"state": "rotated", "generation": claims.Version}); err != nil {
			return err
		}
	} else if input.JoinCode != "" {
		return control.ErrProtocol
	}
	client, err := control.NewClient(control.ClientConfig{Transport: transport, Verifier: verifier, Identity: input.Identity, Credential: input.Credential, DeviceKey: ed25519.NewKeyFromSeed(seed), DeviceKeyID: input.DeviceKeyID, Journal: journal, AgentVersion: "phase01-local-fixture"})
	if err != nil {
		return err
	}
	var outputErr error
	outcome, runErr := control.Run(ctx, control.DefaultPolicy(), control.Dependencies{Dial: client.Dial, Observe: func(state control.State, attempt int) {
		if err := emit(map[string]any{"state": state, "attempt": attempt}); err != nil {
			outputErr = err
			cancel()
		}
	}})
	epoch, err := journal.LastEpoch()
	if err != nil {
		return err
	}
	code := "transport"
	if errors.Is(runErr, control.ErrCredentials) {
		code = "credentials"
	} else if errors.Is(runErr, control.ErrProtocol) {
		code = "protocol"
	} else if errors.Is(runErr, context.Canceled) {
		code = "stopped"
	} else if runErr == nil {
		code = "completed"
	}
	if err := emit(map[string]any{"done": true, "state": outcome.State, "attempts": outcome.Attempts, "epoch": epoch, "code": code}); err != nil {
		return err
	}
	return outputErr
}

func main() {
	if err := run(); err != nil {
		if writeErr := emit(map[string]any{"done": true, "code": "fixture-failed"}); writeErr != nil {
			os.Exit(1)
		}
		os.Exit(1)
	}
}
