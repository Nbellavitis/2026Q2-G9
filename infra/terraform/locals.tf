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
    # Los clientes, sin sesión: ver la cola, unirse, su ticket, el QR y la prueba de salud.
    public = {
      description = "API pública: clientes anónimos, autorizados por su ticket."
      # El QR se genera en memoria: con más memoria, Lambda también da más CPU.
      memory_size = 512
      timeout     = 10
      environment = {
        TABLE_NAME       = module.main_table.dynamodb_table_id
        JOINS_PER_MINUTE = tostring(var.joins_per_minute)
      }
    }
    # El panel. Recibe el usuario ya validado por el authorizer de Cognito.
    staff = {
      description = "API del staff: detrás del authorizer de Cognito."
      memory_size = 512
      timeout     = 15
      environment = {
        TABLE_NAME   = module.main_table.dynamodb_table_id
        USER_POOL_ID = aws_cognito_user_pool.this.id
      }
    }
    # Carga los datos de demo. La invoca Terraform (seed.tf), no API Gateway.
    seed = {
      description = "Datos de demo: un local con dos colas y sus carriles."
      memory_size = 256
      timeout     = 30
      environment = {
        TABLE_NAME = module.main_table.dynamodb_table_id
      }
    }
  }

  # ---------------------------------------------------------------------------------------------
  # Datos de demo
  # ---------------------------------------------------------------------------------------------

  demo            = jsondecode(file("${path.module}/seed/demo.json"))
  demo_staff_name = "Staff de demo"

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
}
