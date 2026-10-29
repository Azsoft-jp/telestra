// Package wireは固定した制御契約を検証する。外部Schema取得や任意命令の実行は行わない。
package wire

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrInvalid = errors.New("制御データの形式または署名を確認してください")

const schemaBase = "https://schema.example.test/tv/v1/"

// 使用する制約だけを生成時に許可する。汎用のJSON Schema準拠を称する実装ではない。
type schema struct {
	ID                   string             `json:"$id"`
	Defs                 map[string]*schema `json:"$defs"`
	Ref                  string             `json:"$ref"`
	Type                 string             `json:"type"`
	Properties           map[string]*schema `json:"properties"`
	Required             []string           `json:"required"`
	AdditionalProperties *bool              `json:"additionalProperties"`
	Const                json.RawMessage    `json:"const"`
	Enum                 []json.RawMessage  `json:"enum"`
	MinLength            *int               `json:"minLength"`
	MaxLength            *int               `json:"maxLength"`
	Pattern              string             `json:"pattern"`
	Minimum              *float64           `json:"minimum"`
	Maximum              *float64           `json:"maximum"`
	Items                *schema            `json:"items"`
	MaxItems             *int               `json:"maxItems"`
	UniqueItems          bool               `json:"uniqueItems"`
	MaxProperties        *int               `json:"maxProperties"`
	Format               string             `json:"format"`
}

var documents = loadDocuments()
var timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$`)

func loadDocuments() map[string]*schema {
	var result map[string]*schema
	if err := json.Unmarshal([]byte(schemaDocuments), &result); err != nil {
		panic("生成済みの制御契約を読み込めません")
	}
	return result
}

// Decodeはサイズ・深さ・重複キー・不正UTF-8を拒否し、後続の契約検証へ渡す。
func Decode(raw []byte, limit int) (any, error) {
	if len(raw) == 0 || len(raw) > limit || !utf8.Valid(raw) {
		return nil, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeValue(decoder, 0)
	if err != nil {
		return nil, ErrInvalid
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, ErrInvalid
	}
	return value, nil
}
func decodeValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, ErrInvalid
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return token, nil
	}
	switch delimiter {
	case '{':
		result := map[string]any{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, ErrInvalid
			}
			if _, duplicate := result[name]; duplicate {
				return nil, ErrInvalid
			}
			value, err := decodeValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			result[name] = value
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, ErrInvalid
		}
		return result, nil
	case '[':
		result := []any{}
		for decoder.More() {
			value, err := decodeValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, ErrInvalid
		}
		return result, nil
	default:
		return nil, ErrInvalid
	}
}

// Validateは埋め込んだcontrol定義だけを解決し、入力から参照先を取得しない。
func Validate(name string, value any) error {
	root := documents[schemaBase+"control.schema.json"]
	if root == nil || root.Defs[name] == nil || !matches(root.Defs[name], root, value, 0) {
		return ErrInvalid
	}
	return nil
}
func matches(rule, root *schema, value any, depth int) bool {
	if rule == nil || depth > 64 {
		return false
	}
	if rule.Ref != "" {
		ref, fragment, _ := strings.Cut(rule.Ref, "#")
		if ref != "" {
			root = documents[ref]
		}
		if root == nil {
			return false
		}
		target := root
		if fragment != "" {
			if !strings.HasPrefix(fragment, "/$defs/") {
				return false
			}
			target = root.Defs[strings.TrimPrefix(fragment, "/$defs/")]
		}
		return matches(target, root, value, depth+1)
	}
	if len(rule.Const) != 0 {
		expected, err := Decode(rule.Const, 16384)
		if err != nil || !equal(expected, value) {
			return false
		}
	}
	if len(rule.Enum) != 0 {
		found := false
		for _, raw := range rule.Enum {
			expected, err := Decode(raw, 16384)
			if err == nil && equal(expected, value) {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	switch rule.Type {
	case "object":
		object, ok := value.(map[string]any)
		if !ok || (rule.MaxProperties != nil && len(object) > *rule.MaxProperties) {
			return false
		}
		for _, key := range rule.Required {
			if _, ok := object[key]; !ok {
				return false
			}
		}
		for key, item := range object {
			child := rule.Properties[key]
			if child == nil {
				if rule.AdditionalProperties != nil && !*rule.AdditionalProperties {
					return false
				}
				continue
			}
			if !matches(child, root, item, depth+1) {
				return false
			}
		}
	case "array":
		array, ok := value.([]any)
		if !ok || (rule.MaxItems != nil && len(array) > *rule.MaxItems) {
			return false
		}
		for i, item := range array {
			if !matches(rule.Items, root, item, depth+1) {
				return false
			}
			if rule.UniqueItems {
				for j := 0; j < i; j++ {
					if equal(array[j], item) {
						return false
					}
				}
			}
		}
	case "string":
		text, ok := value.(string)
		if !ok {
			return false
		}
		length := utf8.RuneCountInString(text)
		if (rule.MinLength != nil && length < *rule.MinLength) || (rule.MaxLength != nil && length > *rule.MaxLength) {
			return false
		}
		if rule.Pattern != "" {
			pattern, err := regexp.Compile(rule.Pattern)
			if err != nil || !pattern.MatchString(text) {
				return false
			}
		}
		if rule.Format == "date-time" {
			if _, err := dateTime(text); err != nil {
				return false
			}
		}
	case "integer", "number":
		number, ok := value.(json.Number)
		if !ok {
			return false
		}
		parsed, err := number.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || math.Abs(parsed) > 9007199254740991 || (rule.Type == "integer" && math.Trunc(parsed) != parsed) || (rule.Minimum != nil && parsed < *rule.Minimum) || (rule.Maximum != nil && parsed > *rule.Maximum) {
			return false
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return false
		}
	case "":
	default:
		return false
	}
	return true
}
func equal(left, right any) bool {
	ln, lok := left.(json.Number)
	rn, rok := right.(json.Number)
	if lok && rok {
		lv, le := ln.Float64()
		rv, re := rn.Float64()
		return le == nil && re == nil && lv == rv
	}
	return reflect.DeepEqual(left, right)
}
func dateTime(raw string) (time.Time, error) {
	// Goが受け付けるカンマ小数などを除き、RFC3339の明示タイムゾーンを要求する。
	if !timestampPattern.MatchString(raw) {
		return time.Time{}, ErrInvalid
	}
	return time.Parse(time.RFC3339Nano, strings.ToUpper(raw))
}
