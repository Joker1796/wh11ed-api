locals {
  function_zip = "${path.module}/../dist/function.zip"
}

# ── Serverless database ────────────────────────────────────────────────────────
resource "yandex_ydb_database_serverless" "main" {
  name      = "wh11ed-api"
  folder_id = var.folder_id
}

# ── Service accounts (least privilege) ─────────────────────────────────────────
# Runtime SA: the function runs as this identity → reads YDB + Lockbox.
resource "yandex_iam_service_account" "runtime" {
  name = "wh11ed-api-runtime"
}

resource "yandex_resourcemanager_folder_iam_member" "runtime_ydb" {
  folder_id = var.folder_id
  role      = "ydb.editor"
  member    = "serviceAccount:${yandex_iam_service_account.runtime.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "runtime_lockbox" {
  folder_id = var.folder_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.runtime.id}"
}

# Gateway SA: the API Gateway invokes the function as this identity.
resource "yandex_iam_service_account" "gateway" {
  name = "wh11ed-api-gateway"
}

resource "yandex_resourcemanager_folder_iam_member" "gateway_invoker" {
  folder_id = var.folder_id
  role      = "functions.functionInvoker"
  member    = "serviceAccount:${yandex_iam_service_account.gateway.id}"
}

# ── Secrets in Lockbox ─────────────────────────────────────────────────────────
resource "yandex_lockbox_secret" "main" {
  name = "wh11ed-api-secrets"
}

resource "yandex_lockbox_secret_version" "main" {
  secret_id = yandex_lockbox_secret.main.id
  entries {
    key        = "JWT_SIGNING_KEY"
    text_value = var.jwt_signing_key
  }
  entries {
    key        = "GOOGLE_CLIENT_ID"
    text_value = var.google_client_id
  }
  entries {
    key        = "GOOGLE_CLIENT_SECRET"
    text_value = var.google_client_secret
  }
  entries {
    key        = "YANDEX_CLIENT_ID"
    text_value = var.yandex_client_id
  }
  entries {
    key        = "YANDEX_CLIENT_SECRET"
    text_value = var.yandex_client_secret
  }
}

# ── Function ───────────────────────────────────────────────────────────────────
resource "yandex_function" "api" {
  name               = "wh11ed-api"
  runtime            = "nodejs22"
  entrypoint         = "handler.handler"
  memory             = 256
  execution_timeout  = "30"
  service_account_id = yandex_iam_service_account.runtime.id
  user_hash          = filemd5(local.function_zip)

  content {
    zip_filename = local.function_zip
  }

  environment = {
    ALLOWED_ORIGINS     = var.allowed_origins
    API_BASE_URL        = var.api_base_url
    APP_AFTER_LOGIN_URL = var.app_after_login_url
    COOKIE_DOMAIN       = var.cookie_domain
    YDB_ENDPOINT        = yandex_ydb_database_serverless.main.ydb_api_endpoint
    YDB_DATABASE        = yandex_ydb_database_serverless.main.database_path
  }

  # Lockbox-injected secrets become env vars of the same name.
  dynamic "secrets" {
    for_each = toset([
      "JWT_SIGNING_KEY",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "YANDEX_CLIENT_ID",
      "YANDEX_CLIENT_SECRET",
    ])
    content {
      id                   = yandex_lockbox_secret.main.id
      version_id           = yandex_lockbox_secret_version.main.id
      key                  = secrets.value
      environment_variable = secrets.value
    }
  }
}

# ── Managed TLS certificate for the custom domain ──────────────────────────────
resource "yandex_cm_certificate" "api" {
  name    = "wh11ed-api"
  domains = [var.custom_domain]
  managed {
    challenge_type = "DNS_CNAME"
  }
}

# ── API Gateway ────────────────────────────────────────────────────────────────
resource "yandex_api_gateway" "main" {
  name = "wh11ed-api"
  spec = templatefile("${path.module}/openapi.yaml", {
    function_id   = yandex_function.api.id
    gateway_sa_id = yandex_iam_service_account.gateway.id
  })

  custom_domains {
    fqdn           = var.custom_domain
    certificate_id = yandex_cm_certificate.api.id
  }

  depends_on = [yandex_resourcemanager_folder_iam_member.gateway_invoker]
}
