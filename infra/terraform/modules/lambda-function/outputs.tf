output "name" {
  description = "Nombre de la función."
  value       = aws_lambda_function.this.function_name
}

output "arn" {
  description = "ARN de la función."
  value       = aws_lambda_function.this.arn
}

output "invoke_arn" {
  description = "ARN que usa API Gateway para invocarla."
  value       = aws_lambda_function.this.invoke_arn
}

output "log_group_name" {
  description = "Log group donde escribe la función."
  value       = aws_cloudwatch_log_group.this.name
}
