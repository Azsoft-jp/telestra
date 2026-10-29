// checkerrorsは、このGoコードでerror戻り値が破棄されていないか検査する。
// データフローを含む完全な静的解析の代替にはしない。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type pkg struct {
	ImportPath  string
	Dir         string
	Export      string
	GoFiles     []string
	TestGoFiles []string
}

func discarded(files []*ast.File, info *types.Info, fset *token.FileSet) []string {
	var failures []string
	errInterface := types.Universe.Lookup("error").Type().Underlying().(*types.Interface)
	check := func(expression ast.Expr, indexes []int) {
		t := info.TypeOf(expression)
		if t == nil {
			return
		}
		values := []types.Type{t}
		if tuple, ok := t.(*types.Tuple); ok {
			values = nil
			for i := 0; i < tuple.Len(); i++ {
				values = append(values, tuple.At(i).Type())
			}
		}
		for i, value := range values {
			wanted := indexes == nil
			for _, index := range indexes {
				if i == index {
					wanted = true
				}
			}
			if wanted && types.Implements(value, errInterface) {
				failures = append(failures, fset.Position(expression.Pos()).String()+": error result is discarded")
			}
		}
	}
	for _, file := range files {
		ast.Inspect(file, func(node ast.Node) bool {
			switch n := node.(type) {
			case *ast.ExprStmt:
				check(n.X, nil)
			case *ast.DeferStmt:
				check(n.Call, nil)
			case *ast.GoStmt:
				check(n.Call, nil)
			case *ast.AssignStmt:
				if len(n.Rhs) == 1 {
					indexes := []int{}
					for i, lhs := range n.Lhs {
						if id, ok := lhs.(*ast.Ident); ok && id.Name == "_" {
							indexes = append(indexes, i)
						}
					}
					check(n.Rhs[0], indexes)
				} else {
					for i, lhs := range n.Lhs {
						if id, ok := lhs.(*ast.Ident); ok && id.Name == "_" && i < len(n.Rhs) {
							check(n.Rhs[i], nil)
						}
					}
				}
			case *ast.ValueSpec:
				if len(n.Values) == 1 {
					indexes := []int{}
					for i, name := range n.Names {
						if name.Name == "_" {
							indexes = append(indexes, i)
						}
					}
					check(n.Values[0], indexes)
				} else {
					for i, name := range n.Names {
						if name.Name == "_" && i < len(n.Values) {
							check(n.Values[i], nil)
						}
					}
				}
			}
			return true
		})
	}
	return failures
}

func run() error {
	command := exec.Command("go", "list", "-deps", "-test", "-export", "-json", "./nodes/tuner/...", "./scripts/checkerrors")
	output, err := command.Output()
	if err != nil {
		return fmt.Errorf("go list failed: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	var packages []pkg
	exports := map[string]string{}
	for {
		var p pkg
		err := decoder.Decode(&p)
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		packages = append(packages, p)
		exports[p.ImportPath] = p.Export
	}
	fset := token.NewFileSet()
	lookup := func(path string) (io.ReadCloser, error) { return os.Open(exports[path]) }
	compiler := importer.ForCompiler(fset, "gc", lookup)
	var failures []string
	for _, p := range packages {
		if !strings.HasPrefix(p.ImportPath, "github.com/Azsoft-jp/telestra/") || strings.Contains(p.ImportPath, "[") || strings.HasSuffix(p.ImportPath, ".test") {
			continue
		}
		var files []*ast.File
		for _, name := range append(p.GoFiles, p.TestGoFiles...) {
			file, err := parser.ParseFile(fset, filepath.Join(p.Dir, name), nil, 0)
			if err != nil {
				return err
			}
			files = append(files, file)
		}
		info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}}
		config := types.Config{Importer: compiler}
		if _, err := config.Check(p.ImportPath, fset, files, info); err != nil {
			return err
		}
		failures = append(failures, discarded(files, info, fset)...)
	}
	if len(failures) > 0 {
		return fmt.Errorf("unchecked errors: %v", failures)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		if _, writeErr := fmt.Fprintln(os.Stderr, err); writeErr != nil {
			os.Exit(1)
		}
		os.Exit(1)
	}
}
