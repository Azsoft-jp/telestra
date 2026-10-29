# ADR-017 Telestraの名称と公開整備

状態は採用。2026年10月29日のユーザー追加指示と回答に基づく。本体の段階実装を保ち、整備作業をPROJECT-01で追跡する。

## 選択と理由

正式名称Telestra、CLI telestra、npm telestraと@telestra/*、Go module github.com/Azsoft-jp/telestra、構成TELESTRA_*へ統一する。所有者は実在するUserのAzsoft-jp、本体はユーザーが選んだMITとする。PUBLICとPRIVATEを分け、秘密はどちらにも置かない。

未公開のパッケージ・import・内部環境変数を変え、参照先、lockfile、生成物、試験を確認する。既存のnpm run mockは維持する。JWT typ/audience、X-TV-Device-Proof、Schema ID、protocolVersion、履歴versionは既存契約として維持する。ブランド変更だけで資格と永続形式を変えない。

## 代替案とトレードオフ

全てのtv文字列を一括変更する案は、既存のToken・Schema参照・署名用途を破壊するため採用しない。旧環境変数を無期限aliasで受ける案も、未公開の内部設定を長く維持する負担があるため採用しない。用途別の境界を維持し、wireのv2移行は別ADRへ分ける。

## 見直し条件と質問候補

公開済みクライアントの移行が必要になった場合、互換期間と失効規則を定める。商標、最終ロゴ、安定版Release、Compose、実環境の料金・保護環境は未確認である。名称整備やMITを、第三者依存・放送素材・サービス利用条件の一括許諾と扱わない。
