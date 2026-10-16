module "functions" {
  source   = "./modules/lambda-function"
  for_each = local.functions

  name               = format("%s-%s", var.project, each.key)
  description        = each.value.description
  source_file        = "${var.functions_dist_dir}/${each.key}/index.mjs"
  memory_size        = each.value.memory_size
  timeout            = each.value.timeout
  environment        = each.value.environment
  role_arn           = data.aws_iam_role.lab.arn
  artifacts_bucket   = module.private_buckets["artefactos"].name
  log_retention_days = var.log_retention_days
}
