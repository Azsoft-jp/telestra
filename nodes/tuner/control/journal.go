// 小さな制御履歴を永続化する。原本やTokenは保存せず、結果不明の命令は再実行しない。
package control

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
)

var (
	ErrJournal         = errors.New("制御履歴を安全に保存できません")
	ErrJournalLocked   = errors.New("別のAgentが制御履歴を使用しています")
	ErrIndeterminate   = errors.New("以前の命令の結果が不明です。確認が必要です")
	ErrCommandConflict = errors.New("同じ命令IDで内容を変更できません")
)

const journalBytes = 65536

var journalID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{3,128}$`)
var journalHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Resultは命令への応答であり、原本保存や録画完了の証明ではない。
type Result struct {
	Accepted bool   `json:"accepted"`
	Code     string `json:"code"`
}

func (r Result) valid() bool {
	return r.Accepted == (r.Code == "accepted") && (r.Code == "accepted" || r.Code == "not implemented" || r.Code == "denied" || r.Code == "expired")
}

type journalEntry struct {
	Fingerprint string  `json:"fingerprint"`
	State       string  `json:"state"`
	Result      *Result `json:"result,omitempty"`
}
type journalData struct {
	Version    int                     `json:"version"`
	Identity   wire.Identity           `json:"identity"`
	LastEpoch  int64                   `json:"lastEpoch"`
	Entries    map[string]journalEntry `json:"entries"`
	Legacy     bool                    `json:"legacy,omitempty"`
	Enrollment *enrollmentCheckpoint   `json:"enrollment,omitempty"`
}

// Journalは排他ロックを保持し、別プロセスや並行呼出しによる二重処理を防ぐ。
type Journal struct {
	mu        sync.Mutex
	directory string
	lock      *os.File
	data      journalData
	capacity  int
	closed    bool
	faulty    bool
	write     func(string, journalData) error
}

// OpenJournalは専用0700ディレクトリを使い、0600の履歴とOSロックを確認する。
func OpenJournal(directory string, identity wire.Identity, capacity int) (*Journal, error) {
	if !journalID.MatchString(identity.NodeID) || !journalID.MatchString(identity.TenantID) || (identity.Environment != "development" && identity.Environment != "staging" && identity.Environment != "production") || (identity.Role != "tuner" && identity.Role != "encoder") || capacity < 1 || capacity > 128 {
		return nil, ErrJournal
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, ErrJournal
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, ErrJournal
	}
	lock, err := acquireJournalLock(filepath.Join(directory, ".lock"))
	if err != nil {
		return nil, err
	}
	fail := func() (*Journal, error) {
		if err := lock.Close(); err != nil {
			return nil, ErrJournal
		}
		return nil, ErrJournal
	}
	journal := &Journal{directory: directory, lock: lock, capacity: capacity, write: writeJournal, data: journalData{Version: 2, Identity: identity, Entries: map[string]journalEntry{}}}
	file, err := openJournalFile(filepath.Join(directory, "control.json"), os.O_RDONLY, 0600)
	if errors.Is(err, os.ErrNotExist) {
		return journal, nil
	}
	if err != nil {
		return fail()
	}
	metadata, statErr := file.Stat()
	raw, readErr := io.ReadAll(io.LimitReader(file, journalBytes+1))
	closeErr := file.Close()
	if statErr != nil || !metadata.Mode().IsRegular() || metadata.Mode().Perm()&0077 != 0 || readErr != nil || closeErr != nil || len(raw) > journalBytes {
		return fail()
	}
	decoded, err := wire.Decode(raw, journalBytes)
	if err != nil {
		return fail()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var data journalData
	if err := decoder.Decode(&data); err != nil || (data.Version != 1 && data.Version != 2) || data.Identity != identity || data.LastEpoch < 0 || data.LastEpoch > 9007199254740991 || data.Entries == nil || len(data.Entries) > capacity {
		return fail()
	}
	if data.Version == 1 {
		object, ok := decoded.(map[string]any)
		if !ok {
			return fail()
		}
		if _, exists := object["enrollment"]; exists {
			return fail()
		}
		if _, exists := object["legacy"]; exists {
			return fail()
		}
		// 既存の命令履歴を保持し、未記録の鍵と資格を推測で補わない。
		data.Version, data.Legacy = 2, true
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return fail()
	}
	if _, ok := object["lastEpoch"].(json.Number); !ok {
		return fail()
	}
	if value, exists := object["legacy"]; exists {
		if _, ok := value.(bool); !ok {
			return fail()
		}
	}
	if value, exists := object["enrollment"]; exists {
		enrollment, ok := value.(map[string]any)
		if !ok || data.Enrollment == nil {
			return fail()
		}
		if _, exists := enrollment["credentialVersion"]; !exists {
			return fail()
		}
		// encoding/jsonがnullをゼロ値へ変換しても、保存状態の型違反として拒否する。
		for name, value := range enrollment {
			if name == "credentialVersion" {
				if _, ok := value.(json.Number); !ok {
					return fail()
				}
			} else {
				if _, ok := value.(string); !ok {
					return fail()
				}
			}
		}
	}
	if data.Legacy && data.Enrollment != nil && data.Enrollment.Phase == "ready" {
		return fail()
	}
	if data.Enrollment != nil && !data.Enrollment.valid() {
		return fail()
	}
	for id, entry := range data.Entries {
		if !journalID.MatchString(id) || !journalHash.MatchString(entry.Fingerprint) || (entry.State != "pending" && entry.State != "done") || (entry.State == "pending" && entry.Result != nil) || (entry.State == "done" && (entry.Result == nil || !entry.Result.valid())) {
			return fail()
		}
	}
	journal.data = data
	return journal, nil
}

// LastEpochは最後に保存した接続世代を返す。接続通知の巻き戻り検出に使う。
func (j *Journal) LastEpoch() (int64, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed || j.faulty {
		return 0, ErrJournal
	}
	return j.data.LastEpoch, nil
}

// AdvanceEpochは署名検証済みの新しい世代だけを、hello送信前に保存する。
func (j *Journal) AdvanceEpoch(epoch int64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed || j.faulty || (j.data.Enrollment != nil && j.data.Enrollment.Phase == "pending") || epoch <= j.data.LastEpoch || epoch > 9007199254740991 {
		return ErrJournal
	}
	data := j.clone()
	data.LastEpoch = epoch
	return j.commit(data)
}

// Executeは処理前の記録をsyncしてから呼び出し、再送には保存済み結果だけを返す。
func (j *Journal) Execute(command wire.Envelope, now time.Time, handler func(wire.Envelope) (Result, error)) (Result, bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.data.Enrollment != nil && j.data.Enrollment.Phase == "pending" {
		return Result{}, false, ErrRecoveryRequired
	}
	if j.closed || j.faulty || handler == nil || command.Kind != "command" || (command.Type != "capture.start" && command.Type != "capture.cancel") || command.NodeID != j.data.Identity.NodeID || j.data.Identity.Role != "tuner" || !journalID.MatchString(command.MessageID) || command.Epoch != j.data.LastEpoch || command.IssuedAt > now.Unix() || command.ExpiresAt <= now.Unix() || command.ExpiresAt <= command.IssuedAt || command.ExpiresAt-command.IssuedAt > 30 {
		return Result{}, false, ErrJournal
	}
	payload, err := json.Marshal(map[string]any{"type": command.Type, "payload": command.Payload})
	if err != nil || len(payload) > 16384 {
		return Result{}, false, ErrJournal
	}
	decoded, err := wire.Decode(payload, 16384)
	if err != nil {
		return Result{}, false, ErrJournal
	}
	object, ok := decoded.(map[string]any)
	definition := "WsCaptureCancel"
	if command.Type == "capture.start" {
		definition = "WsCaptureStart"
	}
	if !ok || wire.Validate(definition, object["payload"]) != nil {
		return Result{}, false, ErrJournal
	}
	if command.Type == "capture.start" {
		body, ok := object["payload"].(map[string]any)
		if !ok {
			return Result{}, false, ErrJournal
		}
		permit, ok := body["permit"].(map[string]any)
		if !ok {
			return Result{}, false, ErrJournal
		}
		claims, ok := permit["claims"].(map[string]any)
		if !ok || claims["nodeId"] != j.data.Identity.NodeID || claims["captureScope"] == nil {
			return Result{}, false, ErrJournal
		}
	}
	digest := sha256.Sum256(payload)
	fingerprint := hex.EncodeToString(digest[:])
	if previous, ok := j.data.Entries[command.MessageID]; ok {
		if previous.Fingerprint != fingerprint {
			return Result{}, true, ErrCommandConflict
		}
		if previous.State != "done" || previous.Result == nil {
			return Result{}, true, ErrIndeterminate
		}
		return *previous.Result, true, nil
	}
	if len(j.data.Entries) >= j.capacity {
		return Result{}, false, ErrJournal
	}
	data := j.clone()
	data.Entries[command.MessageID] = journalEntry{Fingerprint: fingerprint, State: "pending"}
	if err := j.commit(data); err != nil {
		return Result{}, false, err
	}
	result, err := handler(command)
	if err != nil || !result.valid() {
		return Result{}, false, ErrIndeterminate
	}
	data = j.clone()
	data.Entries[command.MessageID] = journalEntry{Fingerprint: fingerprint, State: "done", Result: &result}
	if err := j.commit(data); err != nil {
		return Result{}, false, err
	}
	return result, false, nil
}
func (j *Journal) clone() journalData {
	data := j.data
	if j.data.Enrollment != nil {
		copy := *j.data.Enrollment
		data.Enrollment = &copy
	}
	data.Entries = make(map[string]journalEntry, len(j.data.Entries))
	for key, value := range j.data.Entries {
		data.Entries[key] = value
	}
	return data
}
func (j *Journal) commit(data journalData) error {
	if err := j.write(j.directory, data); err != nil {
		j.faulty = true
		return ErrJournal
	}
	j.data = data
	return nil
}

// CloseはOSロックを解放する。ロックファイルを削除して別プロセスの排他を壊さない。
func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil
	}
	j.closed = true
	if err := j.lock.Close(); err != nil {
		return ErrJournal
	}
	return nil
}

// 書込・sync・rename・ディレクトリsyncの順で確定し、途中の失敗を成功にしない。
func writeJournal(directory string, data journalData) (result error) {
	raw, err := json.Marshal(data)
	if err != nil || len(raw) > journalBytes {
		return ErrJournal
	}
	file, err := os.CreateTemp(directory, ".control-*")
	if err != nil {
		return ErrJournal
	}
	name := file.Name()
	opened := true
	defer func() {
		if opened {
			if err := file.Close(); err != nil {
				result = ErrJournal
			}
		}
		if name != "" {
			if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
				result = ErrJournal
			}
		}
	}()
	if err := file.Chmod(0600); err != nil {
		return ErrJournal
	}
	written, err := file.Write(raw)
	if err != nil || written != len(raw) {
		return ErrJournal
	}
	if err := file.Sync(); err != nil {
		return ErrJournal
	}
	closeErr := file.Close()
	opened = false
	if closeErr != nil {
		return ErrJournal
	}
	if err := os.Rename(name, filepath.Join(directory, "control.json")); err != nil {
		return ErrJournal
	}
	name = ""
	dir, err := os.Open(directory)
	if err != nil {
		return ErrJournal
	}
	syncErr := dir.Sync()
	closeErr = dir.Close()
	if syncErr != nil || closeErr != nil {
		return ErrJournal
	}
	return nil
}
