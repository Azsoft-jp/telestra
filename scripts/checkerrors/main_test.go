// error戻り値の破棄を検出できるか、正常例と異常例を型情報から確認する。
package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"testing"
)

func TestErrorDiscardDetection(t *testing.T) {
	for _, sample := range []struct {
		body string
		want int
	}{
		{"fail()", 1},
		{"_ = fail()", 1},
		{"_,_ = pair()", 1},
		{"var _, _ = pair()", 1},
		{"defer fail()", 1},
		{"go fail()", 1},
		{"if err:=fail();err!=nil{return}", 0},
		{"_,err:=pair();if err!=nil{return}", 0},
	} {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, "sample.go", "package sample;func fail()error{return nil};func pair()(int,error){return 0,nil};func run(){"+sample.body+"}", 0)
		if err != nil {
			t.Fatal(err)
		}
		info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}}
		config := types.Config{}
		if _, err := config.Check("sample", fset, []*ast.File{file}, info); err != nil {
			t.Fatal(err)
		}
		if got := len(discarded([]*ast.File{file}, info, fset)); got != sample.want {
			t.Fatalf("%s: got %d, want %d", sample.body, got, sample.want)
		}
	}
}
