# SKELETON -- NOT APPLIED, validated only with `tofu validate` (syntax/schema, no plan). Treat as a starting point for review.
# Module versions are UNVERIFIED: confirm at https://registry.terraform.io before use.

module "vpc" {
  source             = "terraform-aws-modules/vpc/aws"
  version            = "~> 5.0" # UNVERIFIED
  name               = var.name
  cidr               = var.vpc_cidr
  azs                = var.azs
  private_subnets    = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets     = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 4, i + 8)]
  database_subnets   = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 4, i + 12)]
  enable_nat_gateway = true
  single_nat_gateway = true # dev cost saving; use one per AZ for prod
}

module "eks" {
  source                               = "terraform-aws-modules/eks/aws"
  version                              = "~> 20.0" # UNVERIFIED
  cluster_name                         = var.name
  cluster_version                      = var.eks_version
  vpc_id                               = module.vpc.vpc_id
  subnet_ids                           = module.vpc.private_subnets
  cluster_endpoint_public_access       = length(var.admin_cidrs) > 0
  cluster_endpoint_public_access_cidrs = var.admin_cidrs
  enable_irsa                          = true
  eks_managed_node_groups = {
    default = { instance_types = ["m6i.large"], min_size = 2, max_size = 6, desired_size = 2 }
  }
}

# ---------------- Postgres (indexer DB). Credentials are generated and managed by RDS in Secrets Manager.
resource "aws_security_group" "db" {
  name   = "${var.name}-db"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}
resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = module.vpc.database_subnets
}
resource "aws_db_instance" "postgres" {
  identifier                  = "${var.name}-pg"
  engine                      = "postgres"
  engine_version              = "16" # UNVERIFIED minor
  instance_class              = var.db_instance_class
  allocated_storage           = 50
  storage_encrypted           = true
  db_name                     = "perps"
  username                    = "perps"
  manage_master_user_password = true # password lives in Secrets Manager, never in tf state/vars
  db_subnet_group_name        = aws_db_subnet_group.this.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  backup_retention_period     = 7
  multi_az                    = false # true for prod
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-pg-final"
}

# ---------------- Redis
resource "aws_security_group" "redis" {
  name   = "${var.name}-redis"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}
resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = module.vpc.private_subnets
}
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.name}-redis"
  description                = "perps redis"
  engine                     = "redis"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
}

# ---------------- Secrets Manager: containers only. Values are put in OUT-OF-BAND (never in terraform / state).
resource "aws_secretsmanager_secret" "keeper_key" {
  name        = "perps/keeper/signing-key"
  description = "Keeper signing key. Populate manually / via KMS-backed flow. Prefer a KMS signer."
}
resource "aws_secretsmanager_secret" "indexer_database_url" { name = "perps/indexer/database-url" }
resource "aws_secretsmanager_secret" "indexer_redis_url" { name = "perps/indexer/redis-url" }

# ---------------- IRSA role for external-secrets operator (read ONLY perps/* secrets)
data "aws_iam_policy_document" "eso" {
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["arn:aws:secretsmanager:${var.region}:*:secret:perps/*"]
  }
}
resource "aws_iam_policy" "eso" {
  name   = "${var.name}-external-secrets"
  policy = data.aws_iam_policy_document.eso.json
}
# TODO: aws_iam_role with OIDC trust (module.eks.oidc_provider_arn) for ServiceAccount external-secrets/external-secrets, attach aws_iam_policy.eso.
