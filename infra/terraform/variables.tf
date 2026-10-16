variable "region" {
  description = "Región de AWS donde se despliega todo. El Learner Lab habilita us-east-1 y us-west-2."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = contains(["us-east-1", "us-west-2"], var.region)
    error_message = "El Learner Lab solo habilita us-east-1 y us-west-2."
  }
}

variable "project" {
  description = "Prefijo de todos los nombres en AWS. Corto, porque los nombres de bucket tienen un máximo de 63 caracteres."
  type        = string
  default     = "q"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,9}$", var.project))
    error_message = "El prefijo va en minúsculas, empieza con una letra y tiene hasta 10 caracteres."
  }
}

variable "lab_role_name" {
  description = "Rol que provee el Learner Lab. Es el único disponible, porque el lab no permite crear roles."
  type        = string
  default     = "LabRole"
}

variable "api_stage_name" {
  description = "Stage de la API REST. Forma parte de la URL, así que el frontend se compila con el mismo valor como ruta base."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z0-9]+$", var.api_stage_name))
    error_message = "El stage va en minúsculas y sin símbolos, porque aparece en la URL."
  }
}

variable "site_dir" {
  description = "Carpeta con el build estático del frontend (`npm run build` deja el resultado en `out/`)."
  type        = string
  default     = "../../frontend/out"
}

variable "functions_dist_dir" {
  description = "Carpeta con los bundles de las funciones (`npm run build` en `functions/`)."
  type        = string
  default     = "../../functions/dist"
}

variable "log_retention_days" {
  description = "Días que CloudWatch guarda los logs de las funciones."
  type        = number
  default     = 14
}

variable "access_logs_expiration_days" {
  description = "Días que se guardan los registros de acceso de los buckets."
  type        = number
  default     = 30
}

variable "api_throttle_rate_limit" {
  description = "Pedidos por segundo sostenidos que acepta la API antes de responder 429."
  type        = number
  default     = 50
}

variable "api_throttle_burst_limit" {
  description = "Pedidos que la API acepta de golpe en una ráfaga."
  type        = number
  default     = 100
}
