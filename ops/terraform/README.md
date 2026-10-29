# IaCの検証用テンプレート

frontend-contractは再利用可能な構成検証のModuleである。Cloudflare/AWS資源、認証、DB、実デプロイは作らない。実資源のProvider固定とModuleはPhase 06の残作業であり、このvalidate/planを実環境IaCの合格とは扱わない。

```sh
terraform -chdir=ops/terraform/frontend-contract init -backend=false -input=false
terraform -chdir=ops/terraform/frontend-contract fmt -check
terraform -chdir=ops/terraform/frontend-contract validate
terraform -chdir=ops/terraform/frontend-contract test
terraform -chdir=ops/terraform/frontend-contract plan -input=false -lock=false
```

Terraform 1.17.1で検証する。設定例のzero hashは例示値で、配信済み成果物の証拠ではない。実配信ではビルドを一度だけ作り、その同じhashを両系へ渡す。別OriginでログインとPWA領域を共有しない。

[所有権表](../../docs/07-iac-and-frontend-dr.md)に従い、Terraformがインフラ、WranglerがWorker bundle/version/deployment/DO migration、専用移行ジョブがDB schemaを担当する。PRIVATEはPUBLICの固定SHAと環境別の非秘密設定を保持する。PRではfmt/validate/planを確認し、実apply/deployは保護環境と明示的承認を要する。OIDCは対応可否を検証してから使用し、未対応の経路で長命資格を暗黙に代用しない。
