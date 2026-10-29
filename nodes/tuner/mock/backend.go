// Package mockは合成素材だけを提供する。通信、FFmpeg、EIT解析、DB、UIを含めない。
// 実際のBackendとの互換性は未実装である。
package mock

import (
	"errors"
	"fmt"
)

type Program struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	StartAt  int64  `json:"startAt"`
	Duration int64  `json:"duration"`
}
type Service struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}
type Channel struct {
	Type    string `json:"type"`
	Channel string `json:"channel"`
}

// テスト用の共通面を定義する。実際のMirakurunとmirakcの通信互換性は保証しない。
type Backend interface {
	Name() string
	Programs() []Program
	Services() []Service
	Channels() []Channel
	Stream(serviceID int64) ([]byte, error)
}

type syntheticBackend struct {
	name       string
	packetSize int
}
type MockMirakurun struct{ syntheticBackend }
type MockMirakc struct{ syntheticBackend }

// NewBackendは既知のMock名と188/204のパケット形式だけを受け付ける。
func NewBackend(name string, packetSize int) (Backend, error) {
	if packetSize != 188 && packetSize != 204 {
		return nil, errors.New("パケット形式は188/204だけを指定できます")
	}
	switch name {
	case "mirakurun":
		return MockMirakurun{syntheticBackend{"mirakurun-mock", packetSize}}, nil
	case "mirakc":
		return MockMirakc{syntheticBackend{"mirakc-mock", packetSize}}, nil
	default:
		return nil, errors.New("対応していないMockです")
	}
}
func (b syntheticBackend) Name() string { return b.name }
func (b syntheticBackend) Programs() []Program {
	return []Program{{1, "合成テスト番組", 1793232000000, 60000}}
}
func (b syntheticBackend) Services() []Service { return []Service{{1001, "合成チャンネル"}} }
func (b syntheticBackend) Channels() []Channel { return []Channel{{"GR", "mock-01"}} }
func (b syntheticBackend) Stream(serviceID int64) ([]byte, error) {
	if serviceID != 1001 {
		return nil, errors.New("サービスが見つかりません")
	}
	data := make([]byte, b.packetSize*13)
	for packet := 0; packet < 13; packet++ {
		start := packet * b.packetSize
		for i := 0; i < b.packetSize; i++ {
			data[start+i] = byte((packet*17 + i) % 251)
		}
		copy(data[start:start+4], []byte{0x47, 0x01, 0x00, 0x10 | byte(packet%16)})
	}
	return data, nil
}

// Splitは合成パケットの同期位置と境界を確認する。PESやGOPは解析しない。
func Split(source []byte, packetsPerChunk int) ([][]byte, int, error) {
	if len(source) == 0 || len(source) > 1_048_576 || packetsPerChunk < 1 || packetsPerChunk > 1024 {
		return nil, 0, errors.New("入力サイズを確認してください")
	}
	packetSize := 0
	for _, candidate := range []int{188, 204} {
		if len(source)%candidate != 0 {
			continue
		}
		valid := true
		for i := 0; i < len(source); i += candidate {
			if source[i] != 0x47 {
				valid = false
				break
			}
		}
		if valid {
			if packetSize != 0 {
				return nil, 0, errors.New("パケット形式を一意に判定できません")
			}
			packetSize = candidate
		}
	}
	if packetSize == 0 {
		return nil, 0, errors.New("同期バイトまたはパケット境界が不正です")
	}
	step := packetSize * packetsPerChunk
	if (len(source)+step-1)/step > 64 {
		return nil, 0, fmt.Errorf("Mockのチャンク数上限を超えています")
	}
	chunks := make([][]byte, 0, (len(source)+step-1)/step)
	for offset := 0; offset < len(source); offset += step {
		end := offset + step
		if end > len(source) {
			end = len(source)
		}
		chunks = append(chunks, append([]byte(nil), source[offset:end]...))
	}
	return chunks, packetSize, nil
}
