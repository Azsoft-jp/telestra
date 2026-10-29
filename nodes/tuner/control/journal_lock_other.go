//go:build !linux && !darwin

// 未対応OSで排他を省略して成功させず、明示的に拒否する。
package control

import "os"

func openJournalFile(string, int, os.FileMode) (*os.File, error) { return nil, ErrJournal }
func acquireJournalLock(string) (*os.File, error)                { return nil, ErrJournal }
