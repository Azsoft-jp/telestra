// 履歴の再読込、同時実行、プロセス異常終了、保存失敗を合成命令で検証する。
package control

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

func journalDirectory(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "agent-state")
}

func journalIdentity() wire.Identity {
	return wire.Identity{NodeID: "tuner-local-01", TenantID: "demo-household", Environment: "development", Role: "tuner"}
}
func openTestJournal(t *testing.T, directory string, capacity int) *Journal {
	t.Helper()
	journal, err := OpenJournal(directory, journalIdentity(), capacity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := journal.Close(); err != nil {
			t.Error(err)
		}
	})
	return journal
}
func journalCommand(id string, now time.Time) wire.Envelope {
	return wire.Envelope{MessageID: id, Kind: "command", Type: "capture.cancel", NodeID: "tuner-local-01", Epoch: 1, IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Payload: map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}}
}
func noExecution(wire.Envelope) (Result, error) { return Result{Code: "not implemented"}, nil }

func TestJournalRestartAndConcurrentDeduplication(t *testing.T) {
	directory := journalDirectory(t)
	journal := openTestJournal(t, directory, 32)
	if err := journal.AdvanceEpoch(1); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	command := journalCommand("command-local-01", now)
	var calls atomic.Int32
	var group sync.WaitGroup
	for i := 0; i < 16; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result, _, err := journal.Execute(command, now, func(wire.Envelope) (Result, error) { calls.Add(1); return Result{Code: "not implemented"}, nil })
			if err != nil || result.Code != "not implemented" {
				t.Error("同時再送の処理に失敗")
			}
		}()
	}
	group.Wait()
	if calls.Load() != 1 {
		t.Fatal("同じ命令を複数回処理した")
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	restored := openTestJournal(t, directory, 32)
	epoch, err := restored.LastEpoch()
	if err != nil || epoch != 1 {
		t.Fatal("接続世代を保持していない")
	}
	if err := restored.AdvanceEpoch(1); err == nil {
		t.Fatal("古い接続世代を保存した")
	}
	if err := restored.AdvanceEpoch(2); err != nil {
		t.Fatal(err)
	}
	command.Epoch = 2
	result, replayed, err := restored.Execute(command, now, func(wire.Envelope) (Result, error) {
		t.Error("再起動後に命令を再実行した")
		return Result{}, nil
	})
	if err != nil || !replayed || result.Code != "not implemented" {
		t.Fatal("保存した応答を再利用できない")
	}
	command.Payload["attemptId"] = "attempt-other-01"
	if _, _, err := restored.Execute(command, now, noExecution); !errors.Is(err, ErrCommandConflict) {
		t.Fatal("同じIDで内容を変更した")
	}
}

func TestJournalUncertainOutcomeAndCapacity(t *testing.T) {
	journal := openTestJournal(t, journalDirectory(t), 1)
	if err := journal.AdvanceEpoch(1); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	command := journalCommand("command-uncertain-01", now)
	if _, _, err := journal.Execute(command, now, func(wire.Envelope) (Result, error) { return Result{}, errors.New("合成した実行中断") }); !errors.Is(err, ErrIndeterminate) {
		t.Fatal("結果不明を成功にした")
	}
	if _, _, err := journal.Execute(command, now, func(wire.Envelope) (Result, error) { t.Error("結果不明を再実行した"); return Result{}, nil }); !errors.Is(err, ErrIndeterminate) {
		t.Fatal("結果不明を保持していない")
	}
	if _, _, err := journal.Execute(journalCommand("command-overflow-01", now), now, noExecution); !errors.Is(err, ErrJournal) {
		t.Fatal("履歴上限を越えた")
	}
}

func TestJournalWriteFailureBeforeAndAfterExecution(t *testing.T) {
	for _, failureAt := range []int{1, 2} {
		directory := journalDirectory(t)
		journal := openTestJournal(t, directory, 8)
		if err := journal.AdvanceEpoch(1); err != nil {
			t.Fatal(err)
		}
		original := journal.write
		writes := 0
		called := 0
		journal.write = func(path string, data journalData) error {
			writes++
			if writes == failureAt {
				return ErrJournal
			}
			return original(path, data)
		}
		now := time.Now()
		command := journalCommand("command-write-01", now)
		if _, _, err := journal.Execute(command, now, func(wire.Envelope) (Result, error) { called++; return Result{Code: "not implemented"}, nil }); !errors.Is(err, ErrJournal) {
			t.Fatal("保存失敗を隠した")
		}
		if called != failureAt-1 {
			t.Fatal("処理前に保存していない")
		}
		if err := journal.Close(); err != nil {
			t.Fatal(err)
		}
		restored := openTestJournal(t, directory, 8)
		_, _, err := restored.Execute(command, now, func(wire.Envelope) (Result, error) {
			if failureAt == 2 {
				t.Error("結果保存に失敗した命令を再実行した")
			}
			return Result{Code: "not implemented"}, nil
		})
		if failureAt == 2 && !errors.Is(err, ErrIndeterminate) {
			t.Fatal("結果保存失敗を識別できない")
		}
		if failureAt == 1 && err != nil {
			t.Fatal("未実行の命令を再開できない")
		}
	}
}

func TestJournalLockScopeAndCorruption(t *testing.T) {
	directory := journalDirectory(t)
	journal := openTestJournal(t, directory, 8)
	if _, err := OpenJournal(directory, journalIdentity(), 8); !errors.Is(err, ErrJournalLocked) {
		t.Fatal("別Agentの同時利用を許可した")
	}
	if err := journal.AdvanceEpoch(1); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	foreign := journalIdentity()
	foreign.TenantID = "foreign-household"
	if _, err := OpenJournal(directory, foreign, 8); !errors.Is(err, ErrJournal) {
		t.Fatal("別家庭の履歴を再利用した")
	}
	if err := os.WriteFile(filepath.Join(directory, "control.json"), []byte(`{"version":1`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenJournal(directory, journalIdentity(), 8); !errors.Is(err, ErrJournal) {
		t.Fatal("破損した履歴を初期化して続行した")
	}
	linkDirectory := journalDirectory(t)
	if err := os.Mkdir(linkDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(directory, "control.json"), filepath.Join(linkDirectory, "control.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenJournal(linkDirectory, journalIdentity(), 8); !errors.Is(err, ErrJournal) {
		t.Fatal("symlinkの履歴を読み込んだ")
	}
}

// 子プロセスは処理前の記録を確定した直後に終了し、deferによる解放には依存しない。
func TestJournalCrashWorker(t *testing.T) {
	if os.Getenv("TELESTRA_JOURNAL_CRASH_CHILD") != "1" {
		return
	}
	journal, err := OpenJournal(os.Getenv("TELESTRA_JOURNAL_TEST_DIRECTORY"), journalIdentity(), 8)
	if err != nil {
		os.Exit(31)
	}
	if err := journal.AdvanceEpoch(1); err != nil {
		os.Exit(32)
	}
	if _, _, err := journal.Execute(journalCommand("command-crash-01", time.Now()), time.Now(), func(wire.Envelope) (Result, error) { os.Exit(0); return Result{}, nil }); err != nil {
		os.Exit(33)
	}
	os.Exit(34)
}
func TestJournalProcessCrashReleasesLock(t *testing.T) {
	directory := journalDirectory(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "-test.run=^TestJournalCrashWorker$")
	child.Env = append(os.Environ(), "TELESTRA_JOURNAL_CRASH_CHILD=1", "TELESTRA_JOURNAL_TEST_DIRECTORY="+directory)
	if err := child.Run(); err != nil {
		t.Fatal("合成した異常終了の再現に失敗")
	}
	journal := openTestJournal(t, directory, 8)
	if _, _, err := journal.Execute(journalCommand("command-crash-01", time.Now()), time.Now(), func(wire.Envelope) (Result, error) {
		t.Error("異常終了した命令を再実行した")
		return Result{}, nil
	}); !errors.Is(err, ErrIndeterminate) {
		t.Fatal("異常終了後の結果不明を保持していない")
	}
}

// 保存前に構造を確認し、過大・未知項目・期限切れ・別Nodeの命令を処理しない。
func TestJournalRejectsInvalidCommand(t *testing.T) {
	journal := openTestJournal(t, journalDirectory(t), 8)
	if err := journal.AdvanceEpoch(1); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, mutate := range []func(*wire.Envelope){
		func(c *wire.Envelope) { c.Payload["shell"] = "id" }, func(c *wire.Envelope) { delete(c.Payload, "attemptId") }, func(c *wire.Envelope) { c.NodeID = "tuner-other-01" }, func(c *wire.Envelope) { c.ExpiresAt = now.Unix() }, func(c *wire.Envelope) { c.Epoch = 0 },
	} {
		command := journalCommand("command-invalid-01", now)
		mutate(&command)
		if _, _, err := journal.Execute(command, now, func(wire.Envelope) (Result, error) { t.Error("不正な命令を処理した"); return Result{}, nil }); err == nil {
			t.Fatal("不正な命令を受け付けた")
		}
	}
}
