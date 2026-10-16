output "site_url" {
  description = "Dirección del sitio. Es la que se abre en el navegador."
  value       = "${aws_api_gateway_stage.this.invoke_url}/"
}

output "health_url" {
  description = "Prueba de humo: responde 200 si la función puede escribir y leer la tabla principal."
  value       = "${aws_api_gateway_stage.this.invoke_url}/api/v1/health"
}

output "bucket_names" {
  description = "Los tres buckets privados, por función."
  value       = merge({ for key, bucket in module.private_buckets : key => bucket.name }, { logs = module.logs_bucket.name })
}

output "main_table_name" {
  description = "Tabla principal de DynamoDB."
  value       = module.main_table.dynamodb_table_id
}

output "connections_table_name" {
  description = "Tabla de conexiones WebSocket, con el índice byQueue."
  value       = module.connections_table.dynamodb_table_id
}

output "function_names" {
  description = "Funciones Lambda desplegadas."
  value       = { for key, function in module.functions : key => function.name }
}
