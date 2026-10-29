# 資源を作らず、構成の正常系と拒否条件をplanで検査する。
run "single" {
  command = plan
  assert {
    condition     = output.contract.frontend.mode == "none" && output.contract.backend_dr == "not implemented"
    error_message = "単系の契約とbackendの境界が変わっています。"
  }
}

run "dual" {
  command = plan
  variables {
    frontend = {
      mode             = "dual-static"
      primary_origin   = "https://primary.example.invalid"
      secondary_origin = "https://secondary.example.invalid"
      build_sha256     = "1111111111111111111111111111111111111111111111111111111111111111"
    }
  }
  assert {
    condition     = output.contract.frontend.primary_origin != output.contract.frontend.secondary_origin
    error_message = "別Originの条件を確認してください。"
  }
}

run "deny_same_origin" {
  command = plan
  variables {
    frontend = {
      mode             = "dual-static"
      primary_origin   = "https://primary.example.invalid"
      secondary_origin = "https://primary.example.invalid"
      build_sha256     = "1111111111111111111111111111111111111111111111111111111111111111"
    }
  }
  expect_failures = [var.frontend]
}
