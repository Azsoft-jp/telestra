// プロセス再起動試験の履歴と資格IPCを制限する。本番の鍵保管Providerではない。
package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/control"
)

var checkpointIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// 親が作った0700の試験領域だけを共有する。パス自体を入力にせず、通常試験は終了時に削除する。
func checkpointDirectory(mode, id string) (string, bool, error) {
	shared := mode == "persist-run" || mode == "restore-run"
	if !shared && id == "" {
		directory, err := os.MkdirTemp("", "tv-go-control-")
		if err != nil {
			return "", false, control.ErrJournal
		}
		return directory, true, nil
	}
	if !shared || !checkpointIDPattern.MatchString(id) {
		return "", false, control.ErrProtocol
	}
	directory := filepath.Join(os.TempDir(), "telestra-checkpoint-"+id)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", false, control.ErrJournal
	}
	return directory, false, nil
}

// FD3は親が開いたIPC socketだけを許可する。ファイル・端末・FIFOへ秘密値を書き出さない。
// net.FileConnで複製した接続に期限を設け、親が読まない場合も無期限に待たない。
func openCredentialPipe(file *os.File) (net.Conn, error) {
	if file == nil {
		return nil, control.ErrProtocol
	}
	info, err := file.Stat()
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		if closeErr := file.Close(); closeErr != nil {
			return nil, control.ErrProtocol
		}
		return nil, control.ErrProtocol
	}
	conn, err := net.FileConn(file)
	if closeErr := file.Close(); closeErr != nil {
		if conn != nil {
			if err := conn.Close(); err != nil {
				return nil, control.ErrProtocol
			}
		}
		return nil, control.ErrProtocol
	}
	if err != nil {
		return nil, control.ErrProtocol
	}
	if _, ok := conn.(*net.UnixConn); !ok {
		if err := conn.Close(); err != nil {
			return nil, control.ErrProtocol
		}
		return nil, control.ErrProtocol
	}
	return conn, nil
}

// 検証済みの資格を親のメモリへ返す。stdoutの進捗通知には資格を含めない。
func sendCredential(pipe net.Conn, token string, version int64) error {
	if pipe == nil || len(token) == 0 || len(token) > 8192 || version < 1 || version > 9007199254740991 {
		return control.ErrProtocol
	}
	if err := pipe.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return control.ErrProtocol
	}
	value := struct {
		AccessToken string `json:"accessToken"`
		Generation  int64  `json:"generation"`
	}{token, version}
	if err := json.NewEncoder(pipe).Encode(value); err != nil {
		return control.ErrProtocol
	}
	return nil
}
