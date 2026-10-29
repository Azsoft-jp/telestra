// 合成チューナーの出力をJSONへ変換する。外部の機器や保存先には接続しない。
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/Azsoft-jp/telestra/nodes/tuner/mock"
)

type chunk struct {
	Sequence   int    `json:"sequence"`
	SizeBytes  int    `json:"sizeBytes"`
	SHA256     string `json:"sha256"`
	DataBase64 string `json:"dataBase64"`
}
type capture struct {
	FixtureID          string         `json:"fixtureId"`
	Backend            string         `json:"backend"`
	PacketSize         int            `json:"packetSize"`
	SourceBase64       string         `json:"sourceBase64"`
	SourceStreamSHA256 string         `json:"sourceStreamSha256"`
	Chunks             []chunk        `json:"chunks"`
	Programs           []mock.Program `json:"programs"`
	Services           []mock.Service `json:"services"`
	Channels           []mock.Channel `json:"channels"`
}

func digest(data []byte) string { value := sha256.Sum256(data); return hex.EncodeToString(value[:]) }
func run(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("mock", flag.ContinueOnError)
	backend := flags.String("backend", "mirakurun", "mirakurun / mirakc mock only")
	size := flags.Int("packet-size", 188, "188 / 204")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("余分な引数は指定できません")
	}
	b, err := mock.NewBackend(*backend, *size)
	if err != nil {
		return err
	}
	source, err := b.Stream(1001)
	if err != nil {
		return err
	}
	parts, detected, err := mock.Split(source, 4)
	if err != nil {
		return err
	}
	result := capture{FixtureID: "synthetic-ts-v1", Backend: b.Name(), PacketSize: detected, SourceBase64: base64.StdEncoding.EncodeToString(source), SourceStreamSHA256: digest(source), Chunks: make([]chunk, 0, len(parts)), Programs: b.Programs(), Services: b.Services(), Channels: b.Channels()}
	for seq, data := range parts {
		result.Chunks = append(result.Chunks, chunk{seq, len(data), digest(data), base64.StdEncoding.EncodeToString(data)})
	}
	return json.NewEncoder(output).Encode(result)
}
func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		if _, writeErr := fmt.Fprintln(os.Stderr, "Mock Tunerを実行できませんでした:", err); writeErr != nil {
			os.Exit(1)
		}
		os.Exit(1)
	}
}
