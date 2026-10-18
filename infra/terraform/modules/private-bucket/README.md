# Módulo `private-bucket`

Las decisiones que comparten todos los buckets de Queue, aplicadas sobre un bucket **que ya existe**.

El módulo no crea el bucket. Después de crear un `aws_s3_bucket`, el provider de AWS lee su
configuración de object lock, y el SCP del Learner Lab niega esa lectura con un deny explícito
(`s3:GetBucketObjectLockConfiguration`). Ninguna versión del provider lo tolera: v4.67, v5.100 y v6.67
tratan ese `AccessDenied` como error en la partición `aws`, y la lectura es incondicional. Todas las
demás lecturas de S3 están permitidas, así que el pipeline crea el bucket vacío
([`scripts/buckets.sh`](../../scripts/buckets.sh)) y este módulo administra todo lo que va encima.

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

  name            = "q-logs-123456789012-us-east-1" # tiene que existir antes del apply
  expiration_days = 30
}
```

## Entradas

| Nombre | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `name` | `string` | — | Nombre de un bucket que ya existe |
| `versioning_enabled` | `bool` | `true` | Guarda versiones anteriores |
| `expiration_days` | `number` | `null` | Días hasta que se borran los objetos |
| `access_logs_bucket` | `string` | `null` | Bucket destino de los registros de acceso |
| `access_logs_prefix` | `string` | `""` | Prefijo de esos registros |
| `additional_policy_documents` | `list(string)` | `[]` | Políticas JSON que se suman a la base |

## Salidas

| Nombre | Descripción |
|---|---|
| `name` | Nombre del bucket |
| `arn` | ARN del bucket |

## Decisiones

- **El bucket se recibe, no se crea.** Ver arriba. Por eso no hay `force_destroy` ni `tags`: los dos
  eran atributos de `aws_s3_bucket`. El pipeline vacía y borra los buckets después del `destroy`. El
  ARN se arma con `data "aws_partition"`, que no consulta la API.

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
