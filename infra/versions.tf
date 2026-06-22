terraform {
  required_version = ">= 1.6"
  required_providers {
    yandex = {
      # Fully-qualified host so OpenTofu (default registry registry.opentofu.org) resolves the
      # same FQN as Terraform and can be routed to Yandex's provider mirror (HashiCorp's registry
      # is geo-blocked from RU). For stock Terraform this host is already the default — no change.
      source  = "registry.terraform.io/yandex-cloud/yandex"
      version = ">= 0.130"
    }
  }
}

provider "yandex" {
  cloud_id  = var.cloud_id
  folder_id = var.folder_id
  zone      = var.zone
  # Auth via `yc` CLI profile or YC_TOKEN env var (do not hardcode credentials).
}
