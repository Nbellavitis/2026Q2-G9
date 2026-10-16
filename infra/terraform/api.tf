# La API REST sirve dos cosas desde la misma URL, y por eso el frontend no necesita CORS:
#
#   /              y  /{proxy+}       el sitio, leído del bucket privado con LabRole
#   /api/v1/...                       las funciones Lambda
#
# CloudFront está bloqueado en el Learner Lab. API Gateway es la única puerta con HTTPS propio que
# puede servir el sitio sin dejar el bucket público.

resource "aws_api_gateway_rest_api" "this" {
  name        = format("%s-api", var.project)
  description = "Queue: sitio estático y API"

  # Fuentes, imágenes y el resto de los binarios pasan sin convertirse a texto.
  binary_media_types = ["*/*"]

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

# -------------------------------------------------------------------------------------------------
# Sitio: dos rutas (la raíz y todo lo demás) con la misma integración contra S3
# -------------------------------------------------------------------------------------------------

resource "aws_api_gateway_resource" "site_proxy" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "site" {
  for_each = local.site_routes

  rest_api_id        = aws_api_gateway_rest_api.this.id
  resource_id        = each.value.resource_id
  http_method        = "GET"
  authorization      = "NONE"
  request_parameters = each.value.method_parameters
}

resource "aws_api_gateway_integration" "site" {
  for_each = local.site_routes

  rest_api_id             = aws_api_gateway_rest_api.this.id
  resource_id             = each.value.resource_id
  http_method             = aws_api_gateway_method.site[each.key].http_method
  type                    = "AWS"
  integration_http_method = "GET"
  uri                     = format("arn:aws:apigateway:%s:s3:path/%s/%s", local.region, module.private_buckets["spa"].name, each.value.s3_key)
  credentials             = data.aws_iam_role.lab.arn
  request_parameters      = each.value.integration_parameters
}

resource "aws_api_gateway_method_response" "site" {
  for_each = local.site_route_responses

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = local.site_routes[each.value.route].resource_id
  http_method = aws_api_gateway_method.site[each.value.route].http_method
  status_code = each.value.status_code

  response_parameters = {
    "method.response.header.Content-Type"  = true
    "method.response.header.Cache-Control" = true
  }
}

resource "aws_api_gateway_integration_response" "site" {
  for_each = local.site_route_responses

  rest_api_id       = aws_api_gateway_rest_api.this.id
  resource_id       = local.site_routes[each.value.route].resource_id
  http_method       = aws_api_gateway_method.site[each.value.route].http_method
  status_code       = aws_api_gateway_method_response.site[each.key].status_code
  selection_pattern = each.value.selection_pattern

  # El tipo de contenido y la política de caché los decide cada objeto de S3 (site.tf).
  response_parameters = {
    "method.response.header.Content-Type"  = "integration.response.header.Content-Type"
    "method.response.header.Cache-Control" = "integration.response.header.Cache-Control"
  }

  # Una respuesta de integración solo se puede crear cuando la integración existe, pero no la
  # referencia: comparten el método, no un atributo. Sin esto, Terraform las crea en paralelo y la
  # API responde NotFoundException.
  depends_on = [aws_api_gateway_integration.site]
}

# -------------------------------------------------------------------------------------------------
# API: /api/v1/health
# -------------------------------------------------------------------------------------------------

resource "aws_api_gateway_resource" "api" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = "api"
}

resource "aws_api_gateway_resource" "v1" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "v1"
}

resource "aws_api_gateway_resource" "health" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.v1.id
  path_part   = "health"
}

resource "aws_api_gateway_method" "health" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.health.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "health" {
  rest_api_id             = aws_api_gateway_rest_api.this.id
  resource_id             = aws_api_gateway_resource.health.id
  http_method             = aws_api_gateway_method.health.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = module.functions["health"].invoke_arn
}

resource "aws_lambda_permission" "health" {
  statement_id  = "PermitirApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.functions["health"].name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.this.execution_arn}/*/GET/api/v1/health"
}

# -------------------------------------------------------------------------------------------------
# Despliegue
# -------------------------------------------------------------------------------------------------

resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  # Un deployment es una foto de la API: si cambia cualquier ruta o integración, hace falta otro.
  # El hash de su configuración completa es lo que dispara el reemplazo.
  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_rest_api.this.binary_media_types,
      aws_api_gateway_resource.site_proxy,
      aws_api_gateway_method.site,
      aws_api_gateway_integration.site,
      aws_api_gateway_method_response.site,
      aws_api_gateway_integration_response.site,
      aws_api_gateway_resource.health,
      aws_api_gateway_method.health,
      aws_api_gateway_integration.health,
    ]))
  }

  # El stage apunta siempre a un deployment: el nuevo tiene que existir antes de borrar el viejo, o
  # la API queda sin servir durante el reemplazo.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = var.api_stage_name
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  method_path = "*/*"

  # Un techo para toda la API, por encima del cual responde 429 sin invocar ninguna Lambda. Con la
  # concurrencia de Lambda limitada en el lab, es la primera defensa contra una ráfaga.
  settings {
    throttling_rate_limit  = var.api_throttle_rate_limit
    throttling_burst_limit = var.api_throttle_burst_limit
  }
}
