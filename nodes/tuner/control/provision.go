// Nodeの参加・資格更新を固定HTTPS先へ送る。更新結果が不明なら旧資格を隔離し、管理者による再参加を要求する。
package control

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

var ErrRecoveryRequired = errors.New("資格変更の結果を確認できません。管理者が再発行した参加コードで復旧してください")

type ProvisionState string

const (
	NeedsJoin        ProvisionState = "needs-join"
	NeedsRestore     ProvisionState = "needs-restore"
	Provisioning     ProvisionState = "provisioning"
	CredentialReady  ProvisionState = "credential-ready"
	RecoveryRequired ProvisionState = "recovery-required"
)

// ProvisionConfigは設定済みoriginと端末鍵を保持する。応答に含まれる接続先や鍵を使用しない。
// 現段階ではdevelopmentだけを許可し、資格の永続保存方式は規定しない。
type ProvisionConfig struct {
	Endpoint    string
	Roots       *x509.CertPool
	Verifier    *wire.Verifier
	Identity    wire.Identity
	DeviceKey   ed25519.PrivateKey
	DeviceKeyID string
	Journal     *Journal
}

// Provisionerは一つの端末を扱う。並行した変更を拒否し、最後に検証した世代より古い応答を受け付けない。
type Provisioner struct {
	config      ProvisionConfig
	http        *http.Client
	mu          sync.Mutex
	state       ProvisionState
	token       string
	lastVersion int64
	binding     string
	now         func() time.Time
}

// NewProvisionerはHTTPS originだけを許可する。TLS検証を維持し、Proxy、圧縮、リダイレクトを無効にする。
// 同じ履歴の端末鍵・信頼先を照合し、確認情報があれば資格の復元または再参加を要求する。
func NewProvisioner(config ProvisionConfig) (*Provisioner, error) {
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || (endpoint.EscapedPath() != "" && endpoint.EscapedPath() != "/") || endpoint.RawQuery != "" || endpoint.ForceQuery || strings.Contains(config.Endpoint, "#") || endpoint.Opaque != "" || config.Verifier == nil || config.Identity.Environment != "development" || len(config.DeviceKey) != ed25519.PrivateKeySize || config.Journal == nil {
		return nil, ErrPolicy
	}
	if _, err := wire.SignProof(config.DeviceKey, config.DeviceKeyID, config.Identity, "join", "configuration-check", time.Now()); err != nil {
		return nil, ErrCredentials
	}
	config.Endpoint = "https://" + endpoint.Host
	config.Journal.mu.Lock()
	validJournal := !config.Journal.closed && !config.Journal.faulty && config.Journal.data.Identity == config.Identity
	config.Journal.mu.Unlock()
	if !validJournal {
		return nil, ErrJournal
	}
	binding, err := credentialBinding(config.Endpoint, config.Verifier, config.Identity, config.DeviceKey, config.DeviceKeyID)
	if err != nil {
		return nil, err
	}
	checkpoint, exists, err := config.Journal.loadEnrollment(binding)
	if err != nil {
		return nil, err
	}
	config.DeviceKey = append(ed25519.PrivateKey(nil), config.DeviceKey...)
	if config.Roots != nil {
		config.Roots = config.Roots.Clone()
	}
	transport := &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: config.Roots},
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second,
		MaxResponseHeaderBytes: 16384, DisableCompression: true, MaxIdleConns: 2, IdleConnTimeout: 30 * time.Second,
	}
	state := NeedsJoin
	if exists {
		state = NeedsRestore
		if checkpoint.Phase == "pending" {
			state = RecoveryRequired
		}
	}
	return &Provisioner{config: config, http: &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, state: state, binding: binding, lastVersion: checkpoint.Version, now: time.Now}, nil
}

// Closeは待機中のHTTP接続を解放する。実行中の操作は渡したContextで中断する。
func (p *Provisioner) Close() { p.http.CloseIdleConnections() }

// Statusは資格値を含めず、参加待ち・変更中・利用可能・結果不明を返す。
func (p *Provisioner) Status() ProvisionState {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.expireLocked()
	return p.state
}

// 期限切れは結果不明と分けて参加待ちへ戻す。最後に確認した世代は保持する。
func (p *Provisioner) expireLocked() {
	if p.state == CredentialReady {
		if _, err := p.config.Verifier.VerifyCredential(p.token, p.config.Identity, p.now()); err != nil {
			p.token, p.state = "", NeedsJoin
		}
	}
}

// Currentは検証済みで期限内の資格だけを返す。変更中と結果不明では旧資格を返さない。
// 呼出元も値をログや命令履歴へ保存してはならない。
func (p *Provisioner) Current() (string, wire.Credential, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.expireLocked()
	if p.state != CredentialReady {
		return "", wire.Credential{}, ErrCredentials
	}
	credential, err := p.config.Verifier.VerifyCredential(p.token, p.config.Identity, p.now())
	if err != nil {
		return "", wire.Credential{}, ErrCredentials
	}
	if err := p.config.Journal.checkCredential(p.binding, p.token, credential.Version, false); err != nil {
		return "", wire.Credential{}, errors.Join(ErrCredentials, err)
	}
	return p.token, credential, nil
}

// RestoreCredentialは外部からメモリへ渡された資格を、最後に確定したhash・世代へ照合する。
// 取得・保存は行わず、更新途中の旧資格とv1履歴の推測による復元を拒否する。
func (p *Provisioner) RestoreCredential(token string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state == RecoveryRequired {
		return ErrRecoveryRequired
	}
	if p.state == Provisioning {
		return ErrPolicy
	}
	credential, err := p.config.Verifier.VerifyCredential(token, p.config.Identity, p.now())
	if err != nil || credential.Version != p.lastVersion {
		return ErrCredentials
	}
	if err := p.config.Journal.checkCredential(p.binding, token, credential.Version, false); err != nil {
		return err
	}
	p.token, p.state = token, CredentialReady
	return nil
}

// Joinは管理者が発行した一回限りのコードを端末鍵で証明する。結果不明時も自動再送しない。
func (p *Provisioner) Join(ctx context.Context, code string) error {
	return p.change(ctx, "join", code)
}

// Rotateは現資格のjtiを端末鍵で証明する。送信開始後は旧資格を返さず、新資格だけを確定する。
func (p *Provisioner) Rotate(ctx context.Context) error { return p.change(ctx, "rotate", "") }

func (p *Provisioner) change(ctx context.Context, purpose, code string) (result error) {
	if ctx == nil {
		return ErrPolicy
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	p.expireLocked()
	if p.state == Provisioning {
		p.mu.Unlock()
		return ErrPolicy
	}
	minimum, exact := p.lastVersion, int64(0)
	token, challenge, definition := "", code, "JoinNode"
	value := map[string]any{"nodeId": p.config.Identity.NodeID, "code": code}
	if purpose == "rotate" {
		if p.state != CredentialReady {
			p.mu.Unlock()
			return ErrCredentials
		}
		credential, err := p.config.Verifier.VerifyCredential(p.token, p.config.Identity, p.now())
		if err != nil {
			p.mu.Unlock()
			return ErrCredentials
		}
		if err := p.config.Journal.checkCredential(p.binding, p.token, credential.Version, false); err != nil {
			p.mu.Unlock()
			return err
		}
		token, challenge, definition = p.token, credential.TokenID, "RotateNode"
		exact = credential.Version + 1
		value = map[string]any{}
	} else if p.state == CredentialReady {
		p.mu.Unlock()
		return ErrPolicy
	}
	proof, err := wire.SignProof(p.config.DeviceKey, p.config.DeviceKeyID, p.config.Identity, purpose, challenge, p.now())
	value["proof"] = proof
	if err != nil || wire.Validate(definition, value) != nil {
		p.mu.Unlock()
		return ErrProtocol
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > 8192 {
		p.mu.Unlock()
		return ErrProtocol
	}
	request, err := http.NewRequestWithContext(ctx, "POST", p.config.Endpoint+"/nodes/"+purpose, bytes.NewReader(raw))
	if err != nil {
		p.mu.Unlock()
		return ErrPolicy
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if err := ctx.Err(); err != nil {
		p.mu.Unlock()
		return err
	}
	// ここから先の失敗は未実行と推定しない。資格を確定できるまで他の操作へ渡さない。
	operation, err := p.config.Journal.beginCredential(p.binding, minimum)
	if err != nil {
		p.state, p.token = RecoveryRequired, ""
		p.mu.Unlock()
		return errors.Join(ErrRecoveryRequired, err)
	}
	p.state, p.token = Provisioning, ""
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if result != nil {
			p.state, p.token = RecoveryRequired, ""
			result = errors.Join(ErrRecoveryRequired, result)
		}
	}()
	newToken, credential, err := p.exchange(request)
	if err != nil {
		return err
	}
	if credential.Version <= minimum || (exact != 0 && credential.Version != exact) {
		return ErrProtocol
	}
	if err := p.config.Journal.finishCredential(p.binding, operation, newToken, minimum, credential.Version); err != nil {
		return err
	}
	p.mu.Lock()
	p.token, p.lastVersion, p.state = newToken, credential.Version, CredentialReady
	p.mu.Unlock()
	return nil
}

func (p *Provisioner) exchange(request *http.Request) (token string, credential wire.Credential, result error) {
	response, err := p.http.Do(request)
	if err != nil {
		if request.Context().Err() != nil {
			return "", credential, request.Context().Err()
		}
		return "", credential, ErrTransport
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			result = errors.Join(result, ErrTransport)
		}
	}()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == 401 || response.StatusCode == 403 {
			return "", credential, ErrCredentials
		}
		return "", credential, ErrProtocol
	}
	media, parameters, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || (parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8")) || response.Header.Get("Content-Encoding") != "" || !strings.EqualFold(strings.TrimSpace(response.Header.Get("Cache-Control")), "no-store") || response.ContentLength > controlBytes {
		return "", credential, ErrProtocol
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, controlBytes+1))
	if err != nil {
		return "", credential, ErrTransport
	}
	decoded, err := wire.Decode(raw, controlBytes)
	if err != nil || wire.Validate("CredentialResponse", decoded) != nil {
		return "", credential, ErrProtocol
	}
	value, ok := decoded.(map[string]any)
	if !ok {
		return "", credential, ErrProtocol
	}
	token, _ = value["accessToken"].(string)
	credential, err = p.config.Verifier.VerifyCredential(token, p.config.Identity, p.now())
	version, versionOK := value["credentialVersion"].(json.Number)
	expires, expiresOK := value["expiresAt"].(json.Number)
	if err != nil || !versionOK || !expiresOK || value["nodeId"] != credential.NodeID || value["nodeRole"] != credential.Role {
		return "", wire.Credential{}, ErrProtocol
	}
	// Schemaで53bitの安全な整数へ限定済みなので、1.0や指数表記も同じ値として照合する。
	versionValue, versionErr := version.Float64()
	expiresValue, expiresErr := expires.Float64()
	if versionErr != nil || expiresErr != nil || versionValue != float64(credential.Version) || expiresValue != float64(credential.ExpiresAt) {
		return "", wire.Credential{}, ErrProtocol
	}
	return token, credential, nil
}
