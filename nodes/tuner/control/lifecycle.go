// 期限前の資格更新をWSSと調停する。旧接続を回収してから一度だけ更新し、障害時の再試行枠を引き継ぐ。
package control

import (
	"context"
	"errors"
	"net/url"
	"sync"
	"time"
)

const (
	Refreshing State = "refreshing"
	Refreshed  State = "refreshed"
)

// LifecycleConfigは参加済みの一つの端末を管理する。Run中はProvisionerを他の更新処理と共有しない。
// RenewBeforeは既定30秒。ローカル相互試験では早い更新も指定できるが、本番の推奨値を示すものではない。
type LifecycleConfig struct {
	Provisioner  *Provisioner
	Transport    *WSS
	Journal      *Journal
	AgentVersion string
	RenewBefore  time.Duration
	Policy       Policy
	Observe      func(LifecycleOutcome)
}

// LifecycleOutcomeには状態と件数だけを含める。資格、鍵、参加コードを通知へ含めない。
type LifecycleOutcome struct {
	State             State
	Attempts          int
	Rotations         int
	CredentialVersion int64
}

// Lifecycleは正常な資格更新を継続し、通信障害には有限のRunnerを使う。
// 同じインスタンスの並行Runを拒否し、鍵・資格の永続化や自動再参加は行わない。
type Lifecycle struct {
	config  LifecycleConfig
	mu      sync.Mutex
	active  bool
	started time.Time
	now     func() time.Time
	dial    func(context.Context, string) (Session, error)
	sleep   func(context.Context, time.Duration) error
	random  func() (float64, error)
}

// NewLifecycleはHTTPとWSSのorigin、端末識別、履歴を同じ構成へ拘束し、参加済み資格を検証する。
func NewLifecycle(config LifecycleConfig) (*Lifecycle, error) {
	if config.Provisioner == nil || config.Transport == nil || config.Journal == nil || config.Journal != config.Provisioner.config.Journal {
		return nil, ErrPolicy
	}
	if config.RenewBefore == 0 {
		config.RenewBefore = 30 * time.Second
	}
	if config.Policy == (Policy{}) {
		config.Policy = DefaultPolicy()
	}
	if config.RenewBefore < time.Second || config.RenewBefore >= 300*time.Second || config.Policy.Validate() != nil {
		return nil, ErrPolicy
	}
	endpoint, err := url.Parse(config.Transport.endpoint)
	if err != nil || ValidateEndpoint(config.Transport.endpoint) != nil || "https://"+endpoint.Host != config.Provisioner.config.Endpoint {
		return nil, ErrPolicy
	}
	token, _, err := config.Provisioner.Current()
	if err != nil {
		return nil, err
	}
	l := &Lifecycle{config: config, started: time.Now(), now: time.Now}
	if _, err := l.client(token); err != nil {
		return nil, err
	}
	l.dial = func(ctx context.Context, token string) (Session, error) {
		client, err := l.client(token)
		if err != nil {
			return nil, err
		}
		return client.Dial(ctx)
	}
	return l, nil
}

func (l *Lifecycle) client(token string) (*Client, error) {
	p := l.config.Provisioner
	client, err := NewClient(ClientConfig{Transport: l.config.Transport, Verifier: p.config.Verifier, Identity: p.config.Identity, Credential: token, DeviceKey: p.config.DeviceKey, DeviceKeyID: p.config.DeviceKeyID, Journal: l.config.Journal, AgentVersion: l.config.AgentVersion})
	if err != nil {
		return nil, err
	}
	client.started = l.started
	return client, nil
}

// Runは終了要求まで正常更新を継続する。認証拒否や結果不明では再参加せずに停止する。
// 予定した更新でも障害の再試行枠をリセットしない。各世代の読取goroutineと接続を回収してから次へ進む。
func (l *Lifecycle) Run(ctx context.Context) (result LifecycleOutcome, resultErr error) {
	result.State = Failed
	if ctx == nil {
		return result, ErrPolicy
	}
	l.mu.Lock()
	if l.active {
		l.mu.Unlock()
		return result, ErrPolicy
	}
	l.active = true
	l.mu.Unlock()
	defer func() { l.mu.Lock(); l.active = false; l.mu.Unlock() }()
	update := func(state State) {
		result.State = state
		if l.config.Observe != nil {
			l.config.Observe(result)
		}
	}
	fail := func(err error) (LifecycleOutcome, error) {
		if ctx.Err() != nil {
			update(Stopped)
			return result, errors.Join(ctx.Err(), err)
		}
		update(Failed)
		return result, err
	}
	retries := 0
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		token, credential, err := l.config.Provisioner.Current()
		if err != nil {
			return fail(err)
		}
		result.CredentialVersion = credential.Version
		renewAt := time.Unix(credential.ExpiresAt, 0).Add(-l.config.RenewBefore)
		if l.now().Before(renewAt) {
			policy := l.config.Policy
			policy.MaxAttempts -= retries
			// 正常更新を挟んでも、既に消費した障害回数に応じたbackoffの幅を引き継ぐ。
			for i := 0; i < retries && policy.BaseDelay < policy.MaxDelay; i++ {
				if policy.BaseDelay >= policy.MaxDelay/2 {
					policy.BaseDelay = policy.MaxDelay
				} else {
					policy.BaseDelay *= 2
				}
			}
			if policy.MaxAttempts < 1 {
				return fail(ErrUnavailable)
			}
			generation, cancel := context.WithDeadline(ctx, renewAt)
			previousAttempts := result.Attempts
			last := Connecting
			outcome, runErr := Run(generation, policy, Dependencies{
				Dial: func(ctx context.Context) (Session, error) { return l.dial(ctx, token) }, Sleep: l.sleep, Random: l.random,
				Observe: func(state State, attempts int) {
					if state != Stopped {
						last = state
					}
					result.Attempts = previousAttempts + attempts
					// 世代内の予定中断をAgent全体の停止として通知しない。最終状態は外側で決める。
					if state != Stopped {
						update(state)
					}
				},
			})
			deadlineReached := errors.Is(generation.Err(), context.DeadlineExceeded)
			cancel()
			result.Attempts = previousAttempts + outcome.Attempts
			if ctx.Err() != nil {
				return fail(runErr)
			}
			if runErr == nil {
				update(Completed)
				return result, nil
			}
			// 予定時刻の中断だけを更新へ変換する。Close・署名・認証等の失敗を中断で隠さない。
			if !deadlineReached || !onlyCancellation(runErr) {
				return fail(runErr)
			}
			retries += outcome.Attempts
			if last == Connected && outcome.Attempts > 0 {
				retries--
			}
			if retries >= l.config.Policy.MaxAttempts {
				return fail(ErrUnavailable)
			}
		}
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		update(Refreshing)
		// 旧資格の期限を越えて更新を待たない。送信後の中断はProvisionerが結果不明として隔離する。
		rotation, cancel := context.WithDeadline(ctx, time.Unix(credential.ExpiresAt, 0))
		err = l.config.Provisioner.Rotate(rotation)
		cancel()
		if err != nil {
			return fail(err)
		}
		result.Rotations++
		_, next, err := l.config.Provisioner.Current()
		if err != nil {
			return fail(err)
		}
		// 期限が延びない応答による即時更新ループを防ぐ。古い世代の再利用も受け付けない。
		if next.Version != credential.Version+1 || next.ExpiresAt <= credential.ExpiresAt || !l.now().Before(time.Unix(next.ExpiresAt, 0).Add(-l.config.RenewBefore)) {
			return fail(ErrProtocol)
		}
		result.CredentialVersion = next.Version
		update(Refreshed)
	}
}

// errors.JoinにContext以外の失敗が含まれていれば、予定した更新とは扱わない。
func onlyCancellation(err error) bool {
	if err == nil {
		return false
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		causes := joined.Unwrap()
		if len(causes) == 0 {
			return false
		}
		for _, cause := range causes {
			if !onlyCancellation(cause) {
				return false
			}
		}
		return true
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return onlyCancellation(wrapped.Unwrap())
	}
	return err == context.Canceled || err == context.DeadlineExceeded
}
