terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # TODO(MAN-F04-001): point at the subscription's bootstrap state container before first init.
  # backend "azurerm" {
  #   resource_group_name  = "aizen-tfstate-rg"
  #   storage_account_name = "aizentfstate<suffix>"
  #   container_name       = "tfstate"
  #   key                  = "mvp/terraform.tfstate"
  #   use_azuread_auth     = true
  # }
}

provider "azurerm" {
  features {}

  # subscription_id / tenant_id are read from the environment (ARM_* / `az login`) at init.
}

provider "random" {}
