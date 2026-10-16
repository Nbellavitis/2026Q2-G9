# La tabla principal, con el módulo externo de la comunidad. Su forma es la del diseño de tabla
# única de arquitectura-serverless.md (§5): claves genéricas PK y SK, Streams para el bus de eventos,
# PITR para poder volver a cualquier segundo de los últimos 35 días, y TTL para los ítems que vencen.

module "main_table" {
  source  = "terraform-aws-modules/dynamodb-table/aws"
  version = "5.5.2"

  name         = format("%s-main", var.project)
  hash_key     = "PK"
  range_key    = "SK"
  billing_mode = "PAY_PER_REQUEST"

  attributes = [
    { name = "PK", type = "S" },
    { name = "SK", type = "S" },
  ]

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  point_in_time_recovery_enabled = true

  ttl_enabled        = true
  ttl_attribute_name = "ttl"

  # La cátedra tiene que poder destruir todo.
  deletion_protection_enabled = false
}
