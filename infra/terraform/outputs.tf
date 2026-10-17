output "site_url" {
  description = "Dirección del sitio. Es la que se abre en el navegador."
  value       = "${aws_api_gateway_stage.this.invoke_url}/"
}

output "health_url" {
  description = "Prueba de humo: responde 200 si la API puede escribir y leer la tabla principal."
  value       = "${aws_api_gateway_stage.this.invoke_url}/api/v1/health"
}

output "demo_queue_url" {
  description = "La cola de demo, como la abre un cliente al escanear el QR."
  value       = var.cargar_demo ? format("%s/q/?id=%s", aws_api_gateway_stage.this.invoke_url, local.demo.queues[0].id) : null
}

output "demo_staff_email" {
  description = "Usuario de staff de demo, para entrar al panel."
  value       = var.cargar_demo ? var.demo_email : null
}

output "demo_staff_password" {
  description = "Contraseña del usuario de demo. Se ve con `terraform output -raw demo_staff_password`."
  value       = try(random_password.demo[0].result, null)
  sensitive   = true
}

output "user_pool_id" {
  description = "User pool de Cognito del staff."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_client_id" {
  description = "Cliente de Cognito que usa el sitio."
  value       = aws_cognito_user_pool_client.web.id
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
  value       = merge({ for key, function in module.functions : key => function.name }, { pre_signup = module.pre_signup.name })
}
