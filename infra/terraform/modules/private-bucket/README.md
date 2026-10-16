# Módulo `private-bucket`

Un bucket de S3 privado con las decisiones que comparten todos los buckets de Queue.

| Siempre | Opcional |
|---|---|
| Bloqueo de todo acceso público | Versionado (`versioning_enabled`, encendido por defecto) |
| Propiedad de los objetos de la cuenta, sin ACLs | Expiración de objetos y versiones (`expiration_days`) |
| Política que rechaza todo pedido que no use TLS | Registros de acceso hacia otro bucket (`access_logs_bucket`) |
| | Statements extra en la política (`additional_policy_documents`) |

## Uso

```hcl
module "logs" {
  source = "./modules/private-bucket"

  name            = "q-logs-123456789012-us-east-1"
  force_destroy   = true
  expiration_days = 30
}
```

## Entradas

| Nombre | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `name` | `string` | — | Nombre del bucket (único en todo S3) |
| `force_destroy` | `bool` | `false` | Permite destruirlo con objetos adentro |
| `versioning_enabled` | `bool` | `true` | Guarda versiones anteriores |
| `expiration_days` | `number` | `null` | Días hasta que se borran los objetos |
| `access_logs_bucket` | `string` | `null` | Bucket destino de los registros de acceso |
| `access_logs_prefix` | `string` | `""` | Prefijo de esos registros |
| `additional_policy_documents` | `list(string)` | `[]` | Políticas JSON que se suman a la base |
| `tags` | `map(string)` | `{}` | Tags propios del bucket |

## Salidas

| Nombre | Descripción |
|---|---|
| `name` | Nombre del bucket |
| `arn` | ARN del bucket |

## Decisiones

- **`count` para lo opcional.** Versionado, expiración y registros de acceso son recursos aparte en
  el provider 6 de AWS; crearlos solo cuando se piden evita configuraciones vacías.
- **`access_logs_bucket` recibe un nombre, no un id.** `count` tiene que poder evaluarse en el
  `plan`, y el id de un bucket que todavía no existe recién se conoce en el `apply`. Por eso quien
  llama al módulo tiene que declarar con `depends_on` que el bucket destino se crea antes.
- **El output `name` espera al versionado y a la política** (`depends_on` en el output). Quien usa
  el nombre no ve esos recursos, y un objeto subido antes de activar el versionado quedaría sin
  `version_id`, que es lo que usa una Lambda para apuntar a su zip.
- **`depends_on` entre la política y el bloqueo de acceso público.** No hay referencia entre los dos,
  y S3 rechaza dos cambios de configuración simultáneos sobre el mismo bucket.
