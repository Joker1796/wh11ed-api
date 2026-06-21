output "gateway_default_domain" {
  description = "Default gateway domain — point a CNAME 'api' at this at your DNS provider."
  value       = yandex_api_gateway.main.domain
}

output "ydb_endpoint" {
  value = yandex_ydb_database_serverless.main.ydb_api_endpoint
}

output "ydb_database" {
  value = yandex_ydb_database_serverless.main.database_path
}

output "cert_validation" {
  description = "Add this CNAME so the managed certificate can be issued."
  value       = yandex_cm_certificate.api.challenges
}
