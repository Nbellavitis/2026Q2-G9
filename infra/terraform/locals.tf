locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Los nombres de bucket son globales en S3: la cuenta y la región los hacen únicos en cualquier
  # cuenta del Learner Lab, incluida la de la cátedra.
  name_suffix = "${local.account_id}-${local.region}"

  # Solo variables: estos tags los usa el bloque provider, que no puede depender de datasources.
  tags = {
    Proyecto      = "queue"
    Grupo         = "g9"
    Materia       = "82.08"
    Prefijo       = var.project
    GestionadoPor = "terraform"
  }

  # ---------------------------------------------------------------------------------------------
  # Buckets
  # ---------------------------------------------------------------------------------------------

  # Los buckets que registran su acceso en el de logs. El de logs no se registra a sí mismo: cada
  # registro escrito generaría otro registro.
  logged_buckets = {
    spa = {
      # El sitio se reconstruye desde git en cada despliegue: versionarlo no agrega nada.
      versioning_enabled = false
    }
    artefactos = {
      # Las funciones apuntan a una versión exacta del zip, así que el versionado es obligatorio.
      versioning_enabled = true
    }
  }

  logged_bucket_names = {
    for key in keys(local.logged_buckets) : key => format("%s-%s-%s", var.project, key, local.name_suffix)
  }

  bucket_names = merge(local.logged_bucket_names, {
    logs = format("%s-logs-%s", var.project, local.name_suffix)
  })

  # ---------------------------------------------------------------------------------------------
  # Funciones
  # ---------------------------------------------------------------------------------------------

  # Una entrada por función. El for_each de functions.tf recorre este mapa, así que sumar una
  # función es sumar una entrada acá y su handler en functions/src/handlers/.
  functions = {
    health = {
      description = "Prueba de humo: escribe y lee un ítem en la tabla principal."
      memory_size = 256
      timeout     = 10
      environment = {
        TABLE_NAME = module.main_table.dynamodb_table_id
      }
    }
  }

  # ---------------------------------------------------------------------------------------------
  # Sitio estático
  # ---------------------------------------------------------------------------------------------

  mime_types = {
    html  = "text/html; charset=utf-8"
    txt   = "text/plain; charset=utf-8"
    js    = "text/javascript; charset=utf-8"
    css   = "text/css; charset=utf-8"
    json  = "application/json"
    svg   = "image/svg+xml"
    png   = "image/png"
    ico   = "image/x-icon"
    woff2 = "font/woff2"
  }

  # Si el frontend no está compilado (por ejemplo en `terraform validate`), fileset devuelve un
  # conjunto vacío y no se sube nada.
  site_files = fileset(var.site_dir, "**")

  # Next exporta cada página como <ruta>/index.html, pero la integración de API Gateway con S3 pide
  # la clave tal cual llega en la URL y no agrega index.html. Cada página se sube además con su ruta
  # como clave, con y sin la barra final, así /prod/login/ y /prod/login encuentran el HTML.
  page_files = [for file in local.site_files : file if endswith(file, "/index.html")]

  site_objects = merge(
    { for file in local.site_files : file => file },
    { for file in local.page_files : trimsuffix(file, "index.html") => file },
    { for file in local.page_files : trimsuffix(file, "/index.html") => file },
  )

  # ---------------------------------------------------------------------------------------------
  # Rutas del sitio en API Gateway
  # ---------------------------------------------------------------------------------------------

  # La raíz siempre devuelve index.html; cualquier otra ruta se busca en S3 con la misma clave que
  # trae la URL. Las dos rutas comparten todo lo demás, así que se crean con un solo for_each.
  site_routes = {
    root = {
      resource_id            = aws_api_gateway_rest_api.this.root_resource_id
      s3_key                 = "index.html"
      method_parameters      = {}
      integration_parameters = {}
    }
    proxy = {
      resource_id            = aws_api_gateway_resource.site_proxy.id
      s3_key                 = "{key}"
      method_parameters      = { "method.request.path.proxy" = true }
      integration_parameters = { "integration.request.path.key" = "method.request.path.proxy" }
    }
  }

  # 200 cuando S3 encuentra el objeto; cualquier 4xx de S3 (la clave no existe) se devuelve como 404.
  site_responses = {
    "200" = null
    "404" = "4\\d{2}"
  }

  # Cada ruta con cada respuesta posible.
  site_route_responses = {
    for pair in setproduct(keys(local.site_routes), keys(local.site_responses)) :
    "${pair[0]}-${pair[1]}" => {
      route             = pair[0]
      status_code       = pair[1]
      selection_pattern = local.site_responses[pair[1]]
    }
  }
}
