# フロント配信の構成契約だけを検証する。クラウド資源やState backendを作らない。
terraform {
  required_version = ">= 1.6.0, < 2.0.0"
}

variable "environment" {
  description = "環境の分離単位。実環境の資源IDや秘密値は受け取らない。"
  type        = string
  default     = "development"
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "対応する環境を指定してください。"
  }
}

variable "frontend" {
  description = "同じ成果物を配信するOriginの構成。backend DRは表さない。"
  type = object({
    mode             = string
    primary_origin   = string
    secondary_origin = optional(string)
    build_sha256     = string
  })
  default = {
    mode           = "none"
    primary_origin = "https://primary.example.invalid"
    build_sha256   = "0000000000000000000000000000000000000000000000000000000000000000"
  }
  validation {
    condition     = contains(["none", "dual-static"], var.frontend.mode)
    error_message = "noneまたはdual-staticを指定してください。"
  }
  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.frontend.build_sha256))
    error_message = "同一成果物のSHA-256を指定してください。"
  }
  validation {
    condition = can(regex("^https://[^/?#:@\\s]+(:[0-9]+)?$", var.frontend.primary_origin)) && (
      var.frontend.mode == "none" ? var.frontend.secondary_origin == null : (
        var.frontend.secondary_origin != var.frontend.primary_origin &&
        can(regex("^https://[^/?#:@\\s]+(:[0-9]+)?$", coalesce(var.frontend.secondary_origin, "invalid")))
      )
    )
    error_message = "HTTPSのOriginを指定し、dual-staticでは独立した第二Originを指定してください。"
  }
}

output "contract" {
  description = "配信時に両系で照合する値。Webだけの構成で、資源は未作成。"
  value = {
    environment = var.environment
    frontend    = var.frontend
    backend_dr  = "not implemented"
  }
}
