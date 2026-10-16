# El build estático del frontend, en el bucket privado del sitio. Lo sirve API Gateway (api.tf).

resource "aws_s3_object" "site" {
  for_each = local.site_objects

  bucket = module.private_buckets["spa"].name
  key    = each.key
  source = "${var.site_dir}/${each.value}"
  etag   = filemd5("${var.site_dir}/${each.value}")

  content_type = lookup(local.mime_types, lower(regex("[^.]+$", each.value)), "application/octet-stream")

  # Los archivos de _next/static llevan un hash en el nombre: si cambian, cambia el nombre, así que
  # el navegador los puede guardar un año. Todo lo demás se revalida en cada visita.
  cache_control = startswith(each.key, "_next/static/") ? "public, max-age=31536000, immutable" : "no-cache"
}
