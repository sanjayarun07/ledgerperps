variable "region" {
  type    = string
  default = "us-east-1"
}
variable "name" {
  type    = string
  default = "perps-dev"
}
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
variable "azs" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
}
variable "eks_version" {
  type        = string
  default     = "1.30"
  description = "UNVERIFIED: pick a currently supported EKS version"
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}
variable "admin_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the EKS public endpoint; empty = private endpoint only"
}
