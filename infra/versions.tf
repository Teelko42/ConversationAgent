terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }

  # TODO(MAN-F04-001): point at the account's bootstrap state bucket before first init.
  # backend "s3" {
  #   bucket         = "aizen-tfstate-<account-id>"
  #   key            = "mvp/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "aizen-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "aizen"
      Env       = var.env
      ManagedBy = "terraform"
    }
  }
}
