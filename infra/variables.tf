variable "cloud_id" { type = string }
variable "folder_id" { type = string }
variable "zone" {
  type    = string
  default = "ru-central1-a"
}

# Public config (non-secret) passed to the function as plain env vars.
variable "allowed_origins" {
  type    = string
  default = "https://wh11ed.ru"
}
variable "api_base_url" {
  type        = string
  description = "Public URL of the API, e.g. https://api.wh11ed.ru"
}
variable "app_after_login_url" {
  type        = string
  description = "SPA route to return to after login, e.g. https://wh11ed.ru/#/tracker/auth-callback"
}
variable "cookie_domain" {
  type        = string
  default     = "api.wh11ed.ru"
  description = "Domain attribute for the refresh cookie."
}
variable "custom_domain" {
  type        = string
  default     = "api.wh11ed.ru"
  description = "Custom domain to attach to the API Gateway."
}
variable "attach_custom_domain" {
  type        = bool
  default     = true
  description = "Attach custom_domain to the gateway. Set false for the first apply (cert not yet Issued); flip to true after DNS validation completes."
}

# Secrets — pass via a gitignored *.tfvars or TF_VAR_* env, never commit. Stored in Lockbox.
variable "jwt_signing_key" {
  type      = string
  sensitive = true
}
variable "yandex_client_id" {
  type      = string
  sensitive = true
}
variable "yandex_client_secret" {
  type      = string
  sensitive = true
}
