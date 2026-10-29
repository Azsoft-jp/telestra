// EncodeNode役は制御の署名が正しくても録画命令を拒否する。実Codecや変換能力は広告しない。
package control

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// 誤配送する信頼済みサーバーも想定し、Roleの拒否をWorkerだけに任せない。
func TestClientEncoderRejectsSignedCaptureCommand(t *testing.T) {
	f := newControlFixture(t)
	f.identity.NodeID, f.identity.Role = "encoder-local-01", "encoder"
	f.mint(t, 300)
	journal, err := OpenJournal(journalDirectory(t), f.identity, 16)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := journal.Close(); err != nil {
			t.Error(err)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := f.client(t, func(w http.ResponseWriter, r *http.Request) {
		socket, serverCtx, stop := f.accept(t, w, r, 1)
		if socket == nil {
			return
		}
		defer stop()
		defer closeTestSocket(t, socket)
		if !f.hello(t, serverCtx, socket, 1) {
			return
		}
		if !f.send(t, serverCtx, socket, 1, "command-encoder-denied", "capture.cancel", map[string]any{"recordingId": "recording-local-01", "attemptId": "attempt-local-01"}) {
			return
		}
		if _, _, err := socket.Read(serverCtx); err == nil {
			t.Error("EncodeNode役が録画命令へACKを返した")
		}
	}, journal)
	outcome, err := Run(ctx, DefaultPolicy(), Dependencies{Dial: client.Dial})
	if !errors.Is(err, ErrProtocol) || outcome.State != Failed || outcome.Attempts != 1 {
		t.Fatal("EncodeNode役が録画命令の後も実行を続けた")
	}
	if len(journal.data.Entries) != 0 {
		t.Fatal("EncodeNode役が録画命令を実行履歴へ保存した")
	}
}
