// 両Mock Backendの原本復元と、不正なサービス・パケット境界の拒否を検証する。
package mock

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"testing"
)

func TestSyntheticCapture(t *testing.T) {
	for _, backend := range []string{"mirakurun", "mirakc"} {
		for _, size := range []int{188, 204} {
			t.Run(fmt.Sprintf("%s/%d", backend, size), func(t *testing.T) {
				b, err := NewBackend(backend, size)
				if err != nil {
					t.Fatal(err)
				}
				if len(b.Programs()) == 0 || len(b.Services()) == 0 || len(b.Channels()) == 0 {
					t.Fatal("catalog missing")
				}
				source, err := b.Stream(1001)
				if err != nil {
					t.Fatal(err)
				}
				chunks, packetSize, err := Split(source, 4)
				if err != nil {
					t.Fatal(err)
				}
				if packetSize != size || len(chunks) != 4 {
					t.Fatal("incorrect packet/chunk count")
				}
				joined := bytes.Join(chunks, nil)
				if !bytes.Equal(joined, source) || sha256.Sum256(joined) != sha256.Sum256(source) {
					t.Fatal("MED-01: byte loss")
				}
			})
		}
	}
}

func TestRejectInvalidStream(t *testing.T) {
	b, err := NewBackend("mirakurun", 188)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Stream(9999); err == nil {
		t.Fatal("unknown service accepted")
	}
	source, err := b.Stream(1001)
	if err != nil {
		t.Fatal(err)
	}
	bad := append([]byte(nil), source...)
	bad[188] = 0
	for _, input := range [][]byte{nil, {0x47}, source[:len(source)-1], bad, make([]byte, 1_048_577)} {
		if _, _, err := Split(input, 4); err == nil {
			t.Fatal("bad stream accepted")
		}
	}
	if _, _, err := Split(source, 0); err == nil {
		t.Fatal("zero chunk size accepted")
	}
	if _, err := NewBackend("http://example.test", 188); err == nil {
		t.Fatal("unsupported backend accepted")
	}
	if _, err := NewBackend("mirakc", 192); err == nil {
		t.Fatal("unsupported packet size accepted")
	}
}
