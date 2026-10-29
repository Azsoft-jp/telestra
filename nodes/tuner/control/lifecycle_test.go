// 資格更新と接続の順序、再試行枠、結果不明時の停止を、合成TLSと短い期限で検証する。
package control

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 更新だけを実HTTPへ通す。接続はSession契約のfakeを使い、旧接続を閉じる順序を観測する。
func lifecycleFixture(t *testing.T, failure bool, variant ...string) (*Lifecycle, *[]string, *sync.Mutex) {
	t.Helper()
	f := newControlFixture(t)
	var mu sync.Mutex
	order := []string{}
	version := int64(0)
	var initialExpiry int64
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		version++
		if version > 1 {
			order = append(order, "rotate")
			if failure {
				w.WriteHeader(503)
				return
			}
		}
		value := provisionResponse(t, f, version)
		if version > 1 && len(variant) > 0 {
			expiry := initialExpiry
			if variant[0] == "short" {
				expiry = time.Now().Unix() + 2
			}
			value["expiresAt"] = expiry
			value["accessToken"] = f.sign(t, map[string]any{"iss": "https://control.example.test", "aud": "tv-node-agent", "sub": f.identity.NodeID, "iat": time.Now().Unix(), "exp": expiry, "jti": "credential-refreshed", "tenantId": f.identity.TenantID, "environment": f.identity.Environment, "nodeId": f.identity.NodeID, "nodeRole": f.identity.Role, "credentialVersion": version}, "tv-node+jwt")
		}
		writeProvision(t, w, value)
	})
	p := newProvisionFixture(t, f, server.URL, roots)
	if err := p.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	// 最初の資格だけを短くする。署名と外側の期限は常に一致させる。
	now := time.Now().Unix()
	expiry := now + 2
	mu.Lock()
	initialExpiry = expiry
	mu.Unlock()
	p.token = f.sign(t, map[string]any{"iss": "https://control.example.test", "aud": "tv-node-agent", "sub": f.identity.NodeID, "iat": now, "exp": expiry, "jti": "credential-initial", "tenantId": f.identity.TenantID, "environment": f.identity.Environment, "nodeId": f.identity.NodeID, "nodeRole": f.identity.Role, "credentialVersion": 1}, "tv-node+jwt")
	wss, err := NewWSS("wss://"+strings.TrimPrefix(server.URL, "https://")+"/agent", roots)
	if err != nil {
		t.Fatal("接続先の構築に失敗")
	}
	journal := openTestJournal(t, filepath.Join(t.TempDir(), "journal"), 16)
	l, err := NewLifecycle(LifecycleConfig{Provisioner: p, Transport: wss, Journal: journal, AgentVersion: "test-lifecycle", RenewBefore: time.Second, Policy: DefaultPolicy()})
	if err != nil {
		t.Fatal("資格更新Runnerの構築に失敗")
	}
	return l, &order, &mu
}

type lifecycleSession struct {
	serve func(context.Context) error
	close func() error
}

// 空の原因を返す任意のエラーを、Contextの正常な中断へ読み替えないための合成例。
type emptyCause struct{}

func (emptyCause) Error() string { return "合成した接続解放の失敗" }
func (emptyCause) Unwrap() error { return nil }

func (s *lifecycleSession) Serve(ctx context.Context) error { return s.serve(ctx) }
func (s *lifecycleSession) Close() error                    { return s.close() }

func TestLifecycleClosesThenRotatesAndReconnects(t *testing.T) {
	l, order, mu := lifecycleFixture(t, false)
	var states []State
	l.config.Observe = func(progress LifecycleOutcome) { states = append(states, progress.State) }
	calls := 0
	l.dial = func(ctx context.Context, credential string) (Session, error) {
		calls++
		generation := calls
		mu.Lock()
		*order = append(*order, "dial")
		mu.Unlock()
		return &lifecycleSession{serve: func(ctx context.Context) error {
			if generation == 1 {
				<-ctx.Done()
				return ctx.Err()
			}
			return nil
		}, close: func() error { mu.Lock(); defer mu.Unlock(); *order = append(*order, "close"); return nil }}, nil
	}
	result, err := l.Run(context.Background())
	if err != nil || result.State != Completed || result.Rotations != 1 || result.Attempts != 2 {
		t.Fatal("更新後に接続を再開できません")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(*order, ",") != "dial,close,rotate,dial,close" {
		t.Fatal("旧接続を閉じる前に更新した、または接続が重複した")
	}
	for _, state := range states {
		if state == Stopped || state == Failed {
			t.Fatal("正常な資格更新をAgent全体の停止や失敗として表示した")
		}
	}
}

func TestLifecycleHealthyRotationsDoNotConsumeRetryBudget(t *testing.T) {
	l, _, _ := lifecycleFixture(t, false, "short")
	l.config.Policy.MaxAttempts = 2
	calls := 0
	l.dial = func(context.Context, string) (Session, error) {
		calls++
		generation := calls
		return &lifecycleSession{serve: func(ctx context.Context) error {
			if generation == 10 {
				return nil
			}
			<-ctx.Done()
			return ctx.Err()
		}, close: func() error { return nil }}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	result, err := l.Run(ctx)
	if err != nil || result.State != Completed || result.Attempts != 10 || result.Rotations != 9 {
		t.Fatal("正常な更新で障害再試行枠を消費した")
	}
}

func TestLifecycleRejectsNonExtendingCredential(t *testing.T) {
	l, order, mu := lifecycleFixture(t, false, "unchanged")
	l.dial = func(context.Context, string) (Session, error) {
		return &lifecycleSession{serve: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }, close: func() error { return nil }}, nil
	}
	result, err := l.Run(context.Background())
	if !errors.Is(err, ErrProtocol) || result.Rotations != 1 || result.Attempts != 1 {
		t.Fatal("期限が延びない資格で更新ループを継続した")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(*order, ",") != "rotate" {
		t.Fatal("期限が延びない資格で更新を繰り返した")
	}
}

func TestLifecycleConfigAndConcurrentRun(t *testing.T) {
	l, _, _ := lifecycleFixture(t, false)
	for _, before := range []time.Duration{-time.Second, time.Millisecond, 300 * time.Second} {
		config := l.config
		config.RenewBefore = before
		if _, err := NewLifecycle(config); !errors.Is(err, ErrPolicy) {
			t.Fatal("不正な更新時刻を受理した")
		}
	}
	other, err := NewWSS("wss://another.example.invalid/agent", nil)
	if err != nil {
		t.Fatal("試験用接続先を構築できません")
	}
	config := l.config
	config.Transport = other
	if _, err := NewLifecycle(config); !errors.Is(err, ErrPolicy) {
		t.Fatal("HTTPとWSSの異なるoriginを受理した")
	}
	if _, err := l.Run(nil); !errors.Is(err, ErrPolicy) {
		t.Fatal("Contextなしで開始した")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	l.dial = func(context.Context, string) (Session, error) {
		close(entered)
		return &lifecycleSession{serve: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }, close: func() error { return nil }}, nil
	}
	done := make(chan error, 1)
	go func() { _, err := l.Run(ctx); done <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("接続試行を開始できません")
	}
	if _, err := l.Run(ctx); !errors.Is(err, ErrPolicy) {
		t.Fatal("並行したRunを許可した")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("中断の失敗を隠した")
		}
	case <-time.After(time.Second):
		t.Fatal("Runnerを回収できません")
	}
}

func TestLifecycleStopsOnAmbiguousRotation(t *testing.T) {
	l, order, mu := lifecycleFixture(t, true)
	l.dial = func(context.Context, string) (Session, error) {
		return &lifecycleSession{serve: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }, close: func() error { mu.Lock(); defer mu.Unlock(); *order = append(*order, "close"); return nil }}, nil
	}
	result, err := l.Run(context.Background())
	if !errors.Is(err, ErrRecoveryRequired) || result.Rotations != 0 || result.Attempts != 1 || l.config.Provisioner.Status() != RecoveryRequired {
		t.Fatal("更新結果不明を再試行、または成功とした")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(*order, ",") != "close,rotate" {
		t.Fatal("結果不明の更新を繰り返した")
	}
}

func TestLifecycleDoesNotHideCloseFailure(t *testing.T) {
	for _, cause := range []error{ErrTransport, emptyCause{}} {
		l, order, mu := lifecycleFixture(t, false)
		calls := 0
		l.dial = func(context.Context, string) (Session, error) {
			calls++
			if calls > 1 {
				return nil, ErrProtocol
			}
			return &lifecycleSession{serve: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }, close: func() error { return cause }}, nil
		}
		result, err := l.Run(context.Background())
		if err == nil || result.State != Failed || result.Rotations != 0 {
			t.Fatal("接続解放の失敗を隠した")
		}
		mu.Lock()
		if len(*order) != 0 {
			mu.Unlock()
			t.Fatal("接続解放の失敗後に更新した")
		}
		mu.Unlock()
	}
}

func TestLifecycleStopsOnEarlyCloseFailure(t *testing.T) {
	l, _, _ := lifecycleFixture(t, false)
	l.sleep = func(context.Context, time.Duration) error { return nil }
	l.random = func() (float64, error) { return 0, nil }
	calls := 0
	l.dial = func(context.Context, string) (Session, error) {
		calls++
		return &lifecycleSession{serve: func(context.Context) error { return ErrTransport }, close: func() error { return ErrTransport }}, nil
	}
	result, err := l.Run(context.Background())
	if err == nil || result.State != Failed || result.Attempts != 1 || result.Rotations != 0 || calls != 1 {
		t.Fatal("予定時刻前の接続解放失敗を再試行した")
	}
}

func TestLifecycleRetryBudgetSurvivesRotation(t *testing.T) {
	l, _, _ := lifecycleFixture(t, false)
	l.config.Policy = Policy{BaseDelay: time.Millisecond, MaxDelay: time.Millisecond, MaxAttempts: 2}
	l.sleep = func(context.Context, time.Duration) error { return nil }
	l.random = func() (float64, error) { return 0, nil }
	calls := 0
	l.dial = func(context.Context, string) (Session, error) {
		calls++
		if calls != 2 {
			return nil, ErrTransport
		}
		return &lifecycleSession{serve: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }, close: func() error { return nil }}, nil
	}
	result, err := l.Run(context.Background())
	if !errors.Is(err, ErrUnavailable) || result.Attempts != 3 || result.Rotations != 1 || calls != 3 {
		t.Fatal("正常な資格更新で障害再試行枠をリセットした")
	}
}

func TestLifecycleBackoffSurvivesRotation(t *testing.T) {
	l, _, _ := lifecycleFixture(t, false)
	l.random = func() (float64, error) { return 0, nil }
	var delays []time.Duration
	l.sleep = func(_ context.Context, d time.Duration) error { delays = append(delays, d); return nil }
	calls := 0
	l.dial = func(context.Context, string) (Session, error) {
		calls++
		if calls == 1 || calls == 3 {
			return nil, ErrTransport
		}
		generation := calls
		return &lifecycleSession{serve: func(ctx context.Context) error {
			if generation == 2 {
				<-ctx.Done()
				return ctx.Err()
			}
			return nil
		}, close: func() error { return nil }}, nil
	}
	result, err := l.Run(context.Background())
	if err != nil || result.Rotations != 1 || len(delays) != 2 || delays[0] != 500*time.Millisecond || delays[1] != time.Second {
		t.Fatal("資格更新で指数backoffを初期値へ戻した")
	}
}

func TestLifecycleCancellationAndPermanentFailures(t *testing.T) {
	for _, cause := range []error{ErrCredentials, ErrProtocol, ErrRecoveryRequired} {
		l, order, mu := lifecycleFixture(t, false)
		l.dial = func(context.Context, string) (Session, error) { return nil, cause }
		result, err := l.Run(context.Background())
		if !errors.Is(err, cause) || result.State != Failed || result.Attempts != 1 || result.Rotations != 0 {
			t.Fatal("恒久エラーを更新で回避した")
		}
		mu.Lock()
		if len(*order) != 0 {
			mu.Unlock()
			t.Fatal("認証拒否の後に更新した")
		}
		mu.Unlock()
	}
	l, _, _ := lifecycleFixture(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	l.dial = func(context.Context, string) (Session, error) {
		return &lifecycleSession{serve: func(ctx context.Context) error { cancel(); <-ctx.Done(); return ctx.Err() }, close: func() error { return nil }}, nil
	}
	result, err := l.Run(ctx)
	if !errors.Is(err, context.Canceled) || result.State != Stopped || result.Rotations != 0 {
		t.Fatal("終了要求の後に更新した")
	}
}
