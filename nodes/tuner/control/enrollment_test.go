// 資格そのものを保存せず、鍵・世代・更新途中の確認情報を再読込して拒否条件を検証する。
package control

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func reopenProvisioner(t *testing.T, p *Provisioner) *Provisioner {
	t.Helper()
	config := p.config
	directory := config.Journal.directory
	if err := config.Journal.Close(); err != nil {
		t.Fatal("履歴を閉じられません")
	}
	journal, err := OpenJournal(directory, config.Identity, 16)
	if err != nil {
		t.Fatal("履歴を再読込できません")
	}
	t.Cleanup(func() {
		if err := journal.Close(); err != nil {
			t.Error("履歴を閉じられません")
		}
	})
	config.Journal = journal
	restored, err := NewProvisioner(config)
	if err != nil {
		t.Fatal("参加状態を再読込できません")
	}
	t.Cleanup(restored.Close)
	return restored
}

func TestEnrollmentRejectsStaleClientAndAuthority(t *testing.T) {
	f := newControlFixture(t)
	var requests atomic.Int32
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeProvision(t, w, provisionResponse(t, f, int64(requests.Add(1))))
	})
	p := newProvisionFixture(t, f, server.URL, roots)
	if err := p.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	token, _, err := p.Current()
	if err != nil {
		t.Fatal("資格を確認できません")
	}
	transport, err := NewWSS("wss://"+strings.TrimPrefix(server.URL, "https://")+"/agent", roots)
	if err != nil {
		t.Fatal("接続先を構築できません")
	}
	client, err := NewClient(ClientConfig{Transport: transport, Verifier: f.verifier, Identity: f.identity, Credential: token, DeviceKey: f.deviceKey, DeviceKeyID: "device-test-key", Journal: p.config.Journal, AgentVersion: "checkpoint-test"})
	if err != nil {
		t.Fatal("Clientを構築できません")
	}
	if err := p.Rotate(context.Background()); err != nil {
		t.Fatal("更新に失敗")
	}
	if _, err := client.Dial(context.Background()); err == nil || requests.Load() != 2 {
		t.Fatal("保持済みの旧Clientから接続した")
	}
	config := p.config
	config.Endpoint = "https://another.example.invalid"
	if _, err := NewProvisioner(config); !errors.Is(err, ErrJournal) {
		t.Fatal("別の接続先で同じ履歴を使用した")
	}
	keys := []wire.PublicJWK{{Kty: "OKP", Crv: "Ed25519", X: base64URL.EncodeToString(f.serverKey.Public().(ed25519.PublicKey)), Kid: "control-test-key"}}
	other, err := wire.NewVerifier("https://another-issuer.example.invalid", keys)
	if err != nil {
		t.Fatal("試験の発行者を構築できません")
	}
	config = p.config
	config.Verifier = other
	if _, err := NewProvisioner(config); !errors.Is(err, ErrJournal) {
		t.Fatal("別の発行者で同じ履歴を使用した")
	}
}

func TestEnrollmentLegacyJournalRequiresExplicitJoin(t *testing.T) {
	f := newControlFixture(t)
	directory := journalDirectory(t)
	journal := openTestJournal(t, directory, 16)
	if err := journal.AdvanceEpoch(1); err != nil {
		t.Fatal("試験の世代を保存できません")
	}
	command := journalCommand("command-before-v2", time.Now())
	if _, _, err := journal.Execute(command, time.Now(), noExecution); err != nil {
		t.Fatal("試験の命令を保存できません")
	}
	data := journal.clone()
	data.Version = 1
	if err := journal.Close(); err != nil {
		t.Fatal("履歴を閉じられません")
	}
	if err := writeJournal(directory, data); err != nil {
		t.Fatal("v1履歴を用意できません")
	}
	legacy := openTestJournal(t, directory, 16)
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) { writeProvision(t, w, provisionResponse(t, f, 2)) })
	transport, err := NewWSS("wss://"+strings.TrimPrefix(server.URL, "https://")+"/agent", roots)
	if err != nil {
		t.Fatal("接続先を構築できません")
	}
	if _, err := NewClient(ClientConfig{Transport: transport, Verifier: f.verifier, Identity: f.identity, Credential: f.credential, DeviceKey: f.deviceKey, DeviceKeyID: "device-test-key", Journal: legacy, AgentVersion: "checkpoint-test"}); err == nil {
		t.Fatal("v1履歴の鍵を推測して接続を許可した")
	}
	p, err := NewProvisioner(ProvisionConfig{Endpoint: server.URL, Roots: roots, Verifier: f.verifier, Identity: f.identity, DeviceKey: f.deviceKey, DeviceKeyID: "device-test-key", Journal: legacy})
	if err != nil {
		t.Fatal("v1履歴で参加を準備できません")
	}
	defer p.Close()
	if err := p.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("明示した参加で移行できません")
	}
	if err := legacy.AdvanceEpoch(2); err != nil {
		t.Fatal("既存世代を保持して進められません")
	}
	command.Epoch = 2
	if _, replayed, err := legacy.Execute(command, time.Now(), func(wire.Envelope) (Result, error) {
		t.Error("移行前の命令を再実行した")
		return Result{}, nil
	}); err != nil || !replayed {
		t.Fatal("v1命令履歴を失った")
	}
}

func TestEnrollmentOperationFencesDelayedResponse(t *testing.T) {
	j := openTestJournal(t, journalDirectory(t), 16)
	binding := strings.Repeat("a", 64)
	first, err := j.beginCredential(binding, 0)
	if err != nil {
		t.Fatal("最初の操作を保存できません")
	}
	second, err := j.beginCredential(binding, 0)
	if err != nil {
		t.Fatal("復旧操作を保存できません")
	}
	if err := j.finishCredential(binding, first, "synthetic-first", 0, 1); err == nil {
		t.Fatal("古い操作の応答が新しい操作を上書きした")
	}
	if err := j.finishCredential(binding, second, "synthetic-second", 0, 2); err != nil {
		t.Fatal("新しい操作を確定できません")
	}
	checkpoint, _, err := j.loadEnrollment(binding)
	if err != nil || checkpoint.Version != 2 || checkpoint.Phase != "ready" {
		t.Fatal("確定状態を保持していない")
	}
}

// 子プロセスは開始記録をsyncした直後に終了し、deferによる後始末を行わない。
func TestEnrollmentCrashWorker(t *testing.T) {
	if os.Getenv("TELESTRA_ENROLLMENT_CRASH_CHILD") != "1" {
		return
	}
	j, err := OpenJournal(os.Getenv("TELESTRA_ENROLLMENT_TEST_DIRECTORY"), journalIdentity(), 16)
	if err != nil {
		os.Exit(41)
	}
	if _, err := j.beginCredential(strings.Repeat("a", 64), 0); err != nil {
		os.Exit(42)
	}
	os.Exit(0)
}

func TestEnrollmentCrashKeepsPendingAndLockRecovery(t *testing.T) {
	directory := journalDirectory(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal("試験プロセスを確認できません")
	}
	child := exec.Command(executable, "-test.run=^TestEnrollmentCrashWorker$")
	child.Env = append(os.Environ(), "TELESTRA_ENROLLMENT_CRASH_CHILD=1", "TELESTRA_ENROLLMENT_TEST_DIRECTORY="+directory)
	if err := child.Run(); err != nil {
		t.Fatal("更新開始後の異常終了を再現できません")
	}
	j := openTestJournal(t, directory, 16)
	checkpoint, exists, err := j.loadEnrollment(strings.Repeat("a", 64))
	if err != nil || !exists || checkpoint.Phase != "pending" || checkpoint.Version != 0 {
		t.Fatal("異常終了後の開始記録を失った")
	}
}

func TestEnrollmentRejectsMalformedState(t *testing.T) {
	for _, mode := range []string{"null", "null-version", "null-legacy", "missing-version", "version", "phase", "operation", "extra", "downgrade"} {
		t.Run(mode, func(t *testing.T) {
			directory := journalDirectory(t)
			j := openTestJournal(t, directory, 16)
			if _, err := j.beginCredential(strings.Repeat("a", 64), 0); err != nil {
				t.Fatal("試験状態を作れません")
			}
			raw, err := os.ReadFile(filepath.Join(directory, "control.json"))
			if err != nil {
				t.Fatal("試験状態を読めません")
			}
			if err := j.Close(); err != nil {
				t.Fatal("履歴を閉じられません")
			}
			var value map[string]any
			if err := json.Unmarshal(raw, &value); err != nil {
				t.Fatal("試験状態を解析できません")
			}
			enrollment := value["enrollment"].(map[string]any)
			switch mode {
			case "null-version":
				enrollment["credentialVersion"] = nil
			case "null-legacy":
				value["legacy"] = nil
			case "null":
				value["enrollment"] = nil
			case "missing-version":
				delete(enrollment, "credentialVersion")
			case "version":
				enrollment["credentialVersion"] = -1
			case "phase":
				enrollment["phase"] = "unknown"
			case "operation":
				enrollment["operation"] = "bad"
			case "extra":
				enrollment["unexpected"] = true
			case "downgrade":
				value["version"] = 1
			}
			raw, err = json.Marshal(value)
			if err != nil {
				t.Fatal("不正状態を用意できません")
			}
			if err := os.WriteFile(filepath.Join(directory, "control.json"), raw, 0600); err != nil {
				t.Fatal("不正状態を保存できません")
			}
			if restored, err := OpenJournal(directory, journalIdentity(), 16); err == nil {
				if err := restored.Close(); err != nil {
					t.Error("履歴を閉じられません")
				}
				t.Fatal("不正な参加状態を空として扱った")
			}
		})
	}
}

func TestEnrollmentRestoresOnlyLastCredential(t *testing.T) {
	f := newControlFixture(t)
	var requests atomic.Int32
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeProvision(t, w, provisionResponse(t, f, int64(requests.Add(1))))
	})
	p := newProvisionFixture(t, f, server.URL, roots)
	if err := p.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	old, _, err := p.Current()
	if err != nil {
		t.Fatal("参加資格を取得できません")
	}
	if err := p.Rotate(context.Background()); err != nil {
		t.Fatal("更新に失敗")
	}
	latest, _, err := p.Current()
	if err != nil {
		t.Fatal("更新資格を取得できません")
	}
	restored := reopenProvisioner(t, p)
	if restored.Status() != NeedsRestore {
		t.Fatal("再起動後に資格を自動復元した")
	}
	if err := restored.RestoreCredential(old); !errors.Is(err, ErrCredentials) {
		t.Fatal("旧資格を復元した")
	}
	if err := restored.RestoreCredential(latest); err != nil {
		t.Fatal("最後に保存を確認した資格を復元できません")
	}
	if _, claims, err := restored.Current(); err != nil || claims.Version != 2 || requests.Load() != 2 {
		t.Fatal("復元でHTTP操作を発生させた、または世代を失った")
	}
	raw, err := os.ReadFile(filepath.Join(restored.config.Journal.directory, "control.json"))
	if err != nil || strings.Contains(string(raw), latest) || strings.Contains(string(raw), old) || strings.Contains(string(raw), base64URL.EncodeToString(f.deviceKey.Seed())) {
		t.Fatal("資格または秘密鍵を履歴へ保存した")
	}
	config := restored.config
	_, different, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("試験鍵を生成できません")
	}
	config.DeviceKey = different
	if _, err := NewProvisioner(config); !errors.Is(err, ErrJournal) {
		t.Fatal("別の端末鍵で同じ履歴を使った")
	}
}

func TestEnrollmentPendingSurvivesReopen(t *testing.T) {
	f := newControlFixture(t)
	var requests atomic.Int32
	server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		if n == 2 {
			w.WriteHeader(503)
			return
		}
		writeProvision(t, w, provisionResponse(t, f, int64(n)))
	})
	p := newProvisionFixture(t, f, server.URL, roots)
	if err := p.Join(context.Background(), strings.Repeat("a", 43)); err != nil {
		t.Fatal("参加に失敗")
	}
	old, _, err := p.Current()
	if err != nil {
		t.Fatal("資格を取得できません")
	}
	if err := p.Rotate(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal("結果不明を作れません")
	}
	restored := reopenProvisioner(t, p)
	if restored.Status() != RecoveryRequired {
		t.Fatal("更新途中を参加待ちへ読み替えた")
	}
	if err := restored.RestoreCredential(old); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal("結果不明の旧資格を復元した")
	}
	if err := restored.Rotate(context.Background()); !errors.Is(err, ErrCredentials) || requests.Load() != 2 {
		t.Fatal("更新途中の操作を再送した")
	}
	if err := restored.Join(context.Background(), strings.Repeat("b", 43)); err != nil {
		t.Fatal("管理者が再発行した参加権利で復旧できません")
	}
	if _, claims, err := restored.Current(); err != nil || claims.Version != 3 {
		t.Fatal("既知の世代を保持して復旧できません")
	}
}

func TestEnrollmentWriteFailuresDoNotSendOrAdopt(t *testing.T) {
	for _, at := range []int{1, 2} {
		f := newControlFixture(t)
		var requests atomic.Int32
		server, roots := provisionServer(t, func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			writeProvision(t, w, provisionResponse(t, f, 1))
		})
		p := newProvisionFixture(t, f, server.URL, roots)
		journal := p.config.Journal
		original := journal.write
		writes := 0
		journal.write = func(path string, data journalData) error {
			writes++
			if writes == at {
				return ErrJournal
			}
			return original(path, data)
		}
		if err := p.Join(context.Background(), strings.Repeat("a", 43)); !errors.Is(err, ErrJournal) {
			t.Fatal("保存失敗を無視した")
		}
		if requests.Load() != int32(at-1) {
			t.Fatal("開始記録の保存前に送信した、または応答確定前に資格を使用した")
		}
		if _, _, err := p.Current(); err == nil {
			t.Fatal("保存失敗後に資格を返した")
		}
		if at == 2 && reopenProvisioner(t, p).Status() != RecoveryRequired {
			t.Fatal("保存途中の状態を失った")
		}
	}
}
