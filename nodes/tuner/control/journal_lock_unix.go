//go:build linux || darwin

// OSの排他ロックを使い、Agentが異常終了しても次のプロセスがロックを取得できるようにする。
package control

import (
	"os"
	"syscall"
)

func openJournalFile(path string, flag int, mode os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, mode)
}
func acquireJournalLock(path string) (*os.File, error) {
	file, err := openJournalFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, ErrJournal
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		if err := file.Close(); err != nil {
			return nil, ErrJournal
		}
		return nil, ErrJournal
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if err := file.Close(); err != nil {
			return nil, ErrJournal
		}
		return nil, ErrJournalLocked
	}
	return file, nil
}
