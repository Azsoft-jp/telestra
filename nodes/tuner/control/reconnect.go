// Package controlは有限回の接続試行と中断を管理する。WSS通信や媒体転送はTransportの責務とする。
package control

import (
	"context"
	"crypto/rand"
	"errors"
	"math"
	"math/big"
	"net/url"
	"time"
)

var (
	ErrPolicy      = errors.New("再接続の設定を確認してください")
	ErrCredentials = errors.New("Nodeの資格を更新してください")
	ErrProtocol    = errors.New("制御プロトコルを確認してください")
	ErrUnavailable = errors.New("接続試行の上限に達しました")
)

// Policyは1回のRunに許す総試行回数を定める。短い接続成功で上限をリセットしない。
type Policy struct {
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	MaxAttempts int
}

// DefaultPolicyは1秒から30秒までの待機と、最大8試行を使う。
func DefaultPolicy() Policy {
	return Policy{BaseDelay: time.Second, MaxDelay: 30 * time.Second, MaxAttempts: 8}
}

// Validateは無制限再試行、負の待機、過大な待機を設定段階で拒否する。
func (p Policy) Validate() error {
	if p.BaseDelay < time.Millisecond || p.MaxDelay < p.BaseDelay || p.MaxDelay > time.Minute || p.MaxAttempts < 1 || p.MaxAttempts > 32 {
		return ErrPolicy
	}
	return nil
}

// Delayは上限付き指数backoffに半分から全幅のjitterを加える。sampleは0以上1未満とする。
func (p Policy) Delay(retry int, sample float64) (time.Duration, error) {
	if err := p.Validate(); err != nil {
		return 0, err
	}
	if retry < 1 || retry >= p.MaxAttempts || math.IsNaN(sample) || math.IsInf(sample, 0) || sample < 0 || sample >= 1 {
		return 0, ErrPolicy
	}
	ceiling := p.BaseDelay
	for i := 1; i < retry && ceiling < p.MaxDelay; i++ {
		if ceiling >= p.MaxDelay/2 {
			ceiling = p.MaxDelay
			break
		}
		ceiling *= 2
	}
	return ceiling/2 + time.Duration(float64(ceiling-ceiling/2)*sample), nil
}

// ValidateEndpointは設定された制御先をWSSの固定パスへ限定する。TokenをURLへ入れない。
func ValidateEndpoint(raw string) error {
	value, err := url.Parse(raw)
	if err != nil || value.Scheme != "wss" || value.Hostname() == "" || value.User != nil || value.EscapedPath() != "/agent" || value.RawQuery != "" || value.ForceQuery || value.Fragment != "" || value.Opaque != "" {
		return ErrProtocol
	}
	return nil
}

// Sessionは認証・署名検証を行うTransportが提供する。Serveは切断または中断まで動作する。
type Session interface {
	Serve(context.Context) error
	Close() error
}

type State string

const (
	Connecting   State = "connecting"
	Connected    State = "connected"
	Reconnecting State = "reconnecting"
	Stopped      State = "stopped"
	Failed       State = "failed"
	Completed    State = "completed"
)

// Dependenciesは実通信と時計・乱数の境界を分け、ローカルで障害を再現できるようにする。
type Dependencies struct {
	Dial    func(context.Context) (Session, error)
	Sleep   func(context.Context, time.Duration) error
	Random  func() (float64, error)
	Observe func(State, int)
}
type Outcome struct {
	State    State
	Attempts int
}

// Runは失効・プロトコル違反では再試行せず、通信障害には有限の待機を挟む。
func Run(ctx context.Context, policy Policy, dependencies Dependencies) (Outcome, error) {
	result := Outcome{}
	if ctx == nil || policy.Validate() != nil || dependencies.Dial == nil {
		return Outcome{State: Failed}, ErrPolicy
	}
	if dependencies.Sleep == nil {
		dependencies.Sleep = sleep
	}
	if dependencies.Random == nil {
		dependencies.Random = random
	}
	update := func(state State) {
		result.State = state
		if dependencies.Observe != nil {
			dependencies.Observe(state, result.Attempts)
		}
	}
	for result.Attempts < policy.MaxAttempts {
		if err := ctx.Err(); err != nil {
			update(Stopped)
			return result, err
		}
		result.Attempts++
		update(Connecting)
		connection, err := dependencies.Dial(ctx)
		if err == nil && connection == nil {
			err = ErrProtocol
		}
		if connection != nil {
			if err == nil {
				update(Connected)
				err = connection.Serve(ctx)
			}
			// ServeやDialが失敗しても、取得済み接続を必ず閉じてCloseの失敗も返す。
			err = errors.Join(err, connection.Close())
		}
		if ctx.Err() != nil {
			update(Stopped)
			return result, errors.Join(ctx.Err(), err)
		}
		if err == nil {
			update(Completed)
			return result, nil
		}
		if errors.Is(err, ErrCredentials) || errors.Is(err, ErrProtocol) {
			update(Failed)
			return result, err
		}
		if result.Attempts == policy.MaxAttempts {
			update(Failed)
			return result, errors.Join(ErrUnavailable, err)
		}
		sample, randomErr := dependencies.Random()
		if randomErr != nil {
			update(Failed)
			return result, randomErr
		}
		delay, delayErr := policy.Delay(result.Attempts, sample)
		if delayErr != nil {
			update(Failed)
			return result, delayErr
		}
		update(Reconnecting)
		if sleepErr := dependencies.Sleep(ctx, delay); sleepErr != nil {
			if errors.Is(sleepErr, context.Canceled) || errors.Is(sleepErr, context.DeadlineExceeded) {
				update(Stopped)
			} else {
				update(Failed)
			}
			return result, sleepErr
		}
	}
	return Outcome{State: Failed, Attempts: result.Attempts}, ErrUnavailable
}

// 待機はContextで中断し、資格失効や終了要求を長いsleepで遅らせない。
func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// 乱数の取得失敗を固定値で代用せず、呼出元へ返す。
func random() (float64, error) {
	sample, err := rand.Int(rand.Reader, big.NewInt(1<<53))
	if err != nil {
		return 0, err
	}
	return float64(sample.Int64()) / float64(int64(1<<53)), nil
}
