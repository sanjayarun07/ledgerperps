terraform {
  required_version = ">= 1.5.0" # UNVERIFIED against your toolchain; NOT validated (terraform not installed where this was written)
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" } # UNVERIFIED constraint
  }
}
provider "aws" { region = var.region }
