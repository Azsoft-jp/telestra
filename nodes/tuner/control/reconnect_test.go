// 再接続の上限・jitter・中断・接続解放を、実通信や実時間の待機なしで検証する。
package control

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"
)

type fakeSession struct {
	serveErr error
	closeErr error
	closed   int
}

func (s *fakeSession) Serve(context.Context) error { return s.serveErr }
func (s *fakeSession) Close() error {
	s.closed++
	return s.closeErr
}

func TestBackoffBoundaries(t *testing.T) {
	policy := DefaultPolicy()
	expected := []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 15 * time.Second, 15 * time.Second}
	for retry := 1; retry < policy.MaxAttempts; retry++ {
		lower, err := policy.Delay(retry, 0)
		if err != nil {
			t.Fatal(err)
		}
		upper, err := policy.Delay(retry, 0.999999)
		if err != nil {
			t.Fatal(err)
		}
		if lower != expected[retry-1] {
			t.Fatalf("指数backoffの上限が不正: retry=%d delay=%v", retry, lower)
		}
		if lower < policy.BaseDelay/2 || upper < lower || upper >= policy.MaxDelay {
			t.Fatalf("jitterが設定範囲外: retry=%d", retry)
		}
	}
	for _, sample := range []float64{-1, 1, math.NaN(), math.Inf(1)} {
		if _, err := policy.Delay(1, sample); !errors.Is(err, ErrPolicy) {
			t.Fatal("不正な乱数を受け付けた")
		}
	}
	for _, retry := range []int{0, 8, 1000000} {
		if _, err := policy.Delay(retry, 0.5); !errors.Is(err, ErrPolicy) {
			t.Fatal("総試行回数を越える再試行を受け付けた")
		}
	}
	for _, invalid := range []Policy{{}, {time.Second, time.Millisecond, 8}, {time.Second, time.Hour, 8}, {time.Second, time.Second, 33}} {
		if !errors.Is(invalid.Validate(), ErrPolicy) {
			t.Fatal("無効な再接続設定を受け付けた")
		}
	}
}

func TestReconnectAndRelease(t *testing.T) {
	transient := errors.New("合成した通信断")
	failed := &fakeSession{serveErr: transient}
	completed := &fakeSession{}
	calls := 0
	var delays []time.Duration
	var states []State
	result, err := Run(context.Background(), DefaultPolicy(), Dependencies{
		Dial: func(context.Context) (Session, error) {
			calls++
			if calls == 1 {
				return nil, transient
			}
			if calls == 2 {
				return failed, nil
			}
			return completed, nil
		},
		Sleep:   func(_ context.Context, delay time.Duration) error { delays = append(delays, delay); return nil },
		Random:  func() (float64, error) { return 0, nil },
		Observe: func(state State, _ int) { states = append(states, state) },
	})
	if err != nil || result.State != Completed || result.Attempts != 3 || failed.closed != 1 || completed.closed != 1 {
		t.Fatalf("再接続または接続解放に失敗: result=%+v err=%v", result, err)
	}
	if !reflect.DeepEqual(delays, []time.Duration{500 * time.Millisecond, time.Second}) {
		t.Fatalf("backoffが不正: %v", delays)
	}
	if states[len(states)-1] != Completed {
		t.Fatal("完了状態を通知していない")
	}
}

func TestRetryLimitAndPermanentFailure(t *testing.T) {
	for _, cause := range []error{ErrCredentials, ErrProtocol, errors.New("通信断")} {
		calls := 0
		result, err := Run(context.Background(), Policy{time.Second, time.Second, 3}, Dependencies{
			Dial:   func(context.Context) (Session, error) { calls++; return nil, cause },
			Sleep:  func(context.Context, time.Duration) error { return nil },
			Random: func() (float64, error) { return 0.5, nil },
		})
		expected := 1
		if cause != ErrCredentials && cause != ErrProtocol {
			expected = 3
			if !errors.Is(err, ErrUnavailable) {
				t.Fatal("再試行上限の失敗を返していない")
			}
		}
		if calls != expected || result.Attempts != expected || result.State != Failed {
			t.Fatalf("試行回数が不正: %+v", result)
		}
	}
}

func TestCancellationAndCloseFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	connection := &fakeSession{serveErr: errors.New("切断"), closeErr: errors.New("解放失敗")}
	result, err := Run(ctx, DefaultPolicy(), Dependencies{
		Dial:   func(context.Context) (Session, error) { return connection, nil },
		Random: func() (float64, error) { cancel(); return 0.5, nil },
	})
	if !errors.Is(err, context.Canceled) || result.State != Stopped || connection.closed != 1 {
		t.Fatal("backoff中の中断または解放が不正")
	}
	closed := &fakeSession{closeErr: ErrProtocol}
	result, err = Run(context.Background(), DefaultPolicy(), Dependencies{Dial: func(context.Context) (Session, error) { return closed, nil }})
	if !errors.Is(err, ErrProtocol) || result.State != Failed || closed.closed != 1 {
		t.Fatal("Closeの失敗を無視した")
	}
	called := false
	result, err = Run(ctx, DefaultPolicy(), Dependencies{Dial: func(context.Context) (Session, error) { called = true; return nil, nil }})
	if !errors.Is(err, context.Canceled) || called || result.Attempts != 0 {
		t.Fatal("中断済みContextで接続した")
	}
}

func TestControlEndpoint(t *testing.T) {
	if err := ValidateEndpoint("wss://control.example.test/agent"); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"ws://control.example.test/agent", "https://control.example.test/agent", "wss://user:password@control.example.test/agent", "wss://control.example.test/agent?token=value", "wss://control.example.test/agent#token", "wss://control.example.test/media", "wss://control.example.test/%61gent", "wss://control.example.test/agent?", "/agent"} {
		if !errors.Is(ValidateEndpoint(invalid), ErrProtocol) {
			t.Fatal("禁止した制御先を受け付けた")
		}
	}
}

// 乱数や待機の障害を成功・中断で隠さず、不正なTransportも一度で停止する。
func TestDependencyFailures(t *testing.T) {
	failure := errors.New("合成した依存処理の失敗")
	cases := []Dependencies{
		{Dial: func(context.Context) (Session, error) { return nil, failure }, Random: func() (float64, error) { return 0, failure }},
		{Dial: func(context.Context) (Session, error) { return nil, failure }, Random: func() (float64, error) { return 0.5, nil }, Sleep: func(context.Context, time.Duration) error { return failure }},
		{Dial: func(context.Context) (Session, error) { return nil, nil }},
	}
	for _, dependencies := range cases {
		outcome, err := Run(context.Background(), DefaultPolicy(), dependencies)
		if err == nil || outcome.State != Failed || outcome.Attempts != 1 {
			t.Fatalf("依存処理の失敗を正しく扱わなかった: %+v", outcome)
		}
	}
}
