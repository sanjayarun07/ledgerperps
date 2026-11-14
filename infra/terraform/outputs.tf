output "cluster_name" { value = module.eks.cluster_name }
output "db_endpoint" { value = aws_db_instance.postgres.endpoint }
output "redis_primary_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "db_master_secret_arn" { value = aws_db_instance.postgres.master_user_secret[0].secret_arn }
