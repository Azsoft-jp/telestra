// 再起動fixtureが任意パスやファイルへの資格出力を受け付けないことを検証する。
package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Azsoft-jp/telestra/nodes/tuner/control"
)

func TestCheckpointDirectoryBoundary(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	id := strings.Repeat("a", 32)
	directory := filepath.Join(os.TempDir(), "telestra-checkpoint-"+id)
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"persist-run", "restore-run"} {
		path, cleanup, err := checkpointDirectory(mode, id)
		if err != nil || cleanup || path != directory {
			t.Fatal("親の専用領域を共有できません")
		}
		for _, invalid := range []string{"", "../" + id, strings.ToUpper(id), strings.Repeat("a", 31), strings.Repeat("a", 33)} {
			if _, _, err := checkpointDirectory(mode, invalid); !errors.Is(err, control.ErrProtocol) {
				t.Fatal("不正な領域IDを拒否しません")
			}
		}
	}
	if _, _, err := checkpointDirectory("run", id); !errors.Is(err, control.ErrProtocol) {
		t.Fatal("通常モードが共有履歴を許可しました")
	}
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := checkpointDirectory("restore-run", id); !errors.Is(err, control.ErrJournal) {
		t.Fatal("他利用者が読める領域を拒否しません")
	}
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), directory); err != nil {
		t.Fatal(err)
	}
	if _, _, err := checkpointDirectory("restore-run", id); !errors.Is(err, control.ErrJournal) {
		t.Fatal("シンボリックリンクを拒否しません")
	}
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(directory, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := checkpointDirectory("persist-run", id); !errors.Is(err, control.ErrJournal) {
		t.Fatal("通常ファイルを履歴領域として許可しました")
	}
	path, cleanup, err := checkpointDirectory("run", "")
	if err != nil || !cleanup {
		t.Fatal("通常試験の一時領域を作れません")
	}
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialPipeRejectsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-an-ipc")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if conn, err := openCredentialPipe(file); conn != nil || !errors.Is(err, control.ErrProtocol) {
		t.Fatal("通常ファイルへの資格出力を拒否しません")
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() != 0 {
		t.Fatal("拒否したファイルへ書き込みました")
	}
	if _, err := openCredentialPipe(nil); !errors.Is(err, control.ErrProtocol) {
		t.Fatal("存在しないIPCを拒否しません")
	}
}

func TestCredentialPipeRejectsTCP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
	}()
	client, err := net.DialTimeout("tcp", listener.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	}()
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := server.Close(); err != nil {
			t.Error(err)
		}
	}()
	file, err := server.(*net.TCPConn).File()
	if err != nil {
		t.Fatal(err)
	}
	if conn, err := openCredentialPipe(file); conn != nil || !errors.Is(err, control.ErrProtocol) {
		t.Fatal("TCP接続への資格出力を拒否しません")
	}
}
