// 参加状態の確認情報だけを命令履歴へ保存する。秘密鍵・資格を保存せず、更新途中と巻き戻りを拒否する。
package control

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/Azsoft-jp/telestra/nodes/tuner/wire"
	"regexp"
)

var enrollmentOperation = regexp.MustCompile(`^[a-f0-9]{32}$`)

type enrollmentCheckpoint struct {
	Binding   string `json:"binding"`
	Version   int64  `json:"credentialVersion"`
	TokenHash string `json:"tokenHash,omitempty"`
	Phase     string `json:"phase"`
	Operation string `json:"operation,omitempty"`
}

func (e enrollmentCheckpoint) valid() bool {
	if !journalHash.MatchString(e.Binding) || e.Version < 0 || e.Version > 9007199254740991 {
		return false
	}
	if (e.Version == 0 && e.TokenHash != "") || (e.Version > 0 && !journalHash.MatchString(e.TokenHash)) {
		return false
	}
	return (e.Phase == "ready" && e.Version > 0 && e.Operation == "") || (e.Phase == "pending" && enrollmentOperation.MatchString(e.Operation))
}

func fingerprint(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// 束縛は構成済みの接続先・発行者・端末・公開鍵から作る。鍵集合の更新自体は妨げない。
func credentialBinding(origin string, v *wire.Verifier, identity wire.Identity, key ed25519.PrivateKey, kid string) (string, error) {
	if v == nil || len(key) != ed25519.PrivateKeySize {
		return "", ErrCredentials
	}
	public := key.Public().(ed25519.PublicKey)
	value := struct {
		Origin    string
		Issuer    string
		Identity  wire.Identity
		KeyID     string
		PublicKey string
	}{origin, v.Issuer(), identity, kid, hex.EncodeToString(public)}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", ErrCredentials
	}
	return fingerprint("telestra-node-binding-v1\x00" + string(raw)), nil
}

func (j *Journal) loadEnrollment(binding string) (enrollmentCheckpoint, bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed || j.faulty || !journalHash.MatchString(binding) {
		return enrollmentCheckpoint{}, false, ErrJournal
	}
	if j.data.Enrollment == nil {
		return enrollmentCheckpoint{}, false, nil
	}
	if j.data.Enrollment.Binding != binding {
		return enrollmentCheckpoint{}, false, ErrJournal
	}
	return *j.data.Enrollment, true, nil
}

// 確認済みの資格だけを通す。初回の直接設定は空の新規履歴に限定し、v1履歴では再参加を要求する。
func (j *Journal) checkCredential(binding, token string, version int64, initialize bool) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed || j.faulty || !journalHash.MatchString(binding) || version < 1 || version > 9007199254740991 {
		return ErrJournal
	}
	if current := j.data.Enrollment; current != nil {
		if current.Binding != binding {
			return ErrJournal
		}
		if current.Phase != "ready" {
			return ErrRecoveryRequired
		}
		if current.Version != version || current.TokenHash != fingerprint(token) {
			return ErrCredentials
		}
		return nil
	}
	if !initialize || j.data.Legacy || j.data.LastEpoch != 0 || len(j.data.Entries) != 0 {
		return ErrCredentials
	}
	data := j.clone()
	data.Enrollment = &enrollmentCheckpoint{Binding: binding, Version: version, TokenHash: fingerprint(token), Phase: "ready"}
	return j.commit(data)
}

// 操作IDをsyncしてから送信する。同じ履歴の遅れた応答が、新しい参加操作を確定しないようにする。
func (j *Journal) beginCredential(binding string, expected int64) (string, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed || j.faulty || !journalHash.MatchString(binding) || expected < 0 || expected > 9007199254740991 {
		return "", ErrJournal
	}
	oldHash := ""
	if current := j.data.Enrollment; current != nil {
		if current.Binding != binding || current.Version != expected {
			return "", ErrJournal
		}
		oldHash = current.TokenHash
	} else if expected != 0 {
		return "", ErrJournal
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", ErrJournal
	}
	operation := hex.EncodeToString(nonce[:])
	data := j.clone()
	data.Enrollment = &enrollmentCheckpoint{Binding: binding, Version: expected, TokenHash: oldHash, Phase: "pending", Operation: operation}
	if err := j.commit(data); err != nil {
		return "", err
	}
	return operation, nil
}

// 応答の署名・用途・世代を検証した呼出元からだけ確定する。資格の本文は保持しない。
func (j *Journal) finishCredential(binding, operation, token string, expected, next int64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	current := j.data.Enrollment
	if j.closed || j.faulty || current == nil || current.Binding != binding || current.Phase != "pending" || current.Operation != operation || current.Version != expected || next <= expected || next > 9007199254740991 {
		return ErrJournal
	}
	data := j.clone()
	data.Legacy = false
	data.Enrollment = &enrollmentCheckpoint{Binding: binding, Version: next, TokenHash: fingerprint(token), Phase: "ready"}
	return j.commit(data)
}
