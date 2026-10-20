# Módulo `private-bucket`

Las decisiones que comparten todos los buckets de Queue, aplicadas sobre un bucket **que ya existe**.

El módulo no crea el bucket. Después de crear un `aws_s3_bucket`, el provider de AWS lee su
configuración de object lock, y el SCP del Learner Lab niega esa lectura con un deny explícito
(`s3:GetBucketObjectLockConfiguration`). Las versiones ensayadas en el lab del grupo (v4.67, v5.100 y v6.67)
fallaron ante ese `AccessDenied`; esto no establece el comportamiento de toda versión futura ni
de otra cuenta. Las demás lecturas probadas estaban permitidas, así que el pipeline crea el bucket vacío
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

El ejemplo se evalúa desde la raíz Terraform y usa un nombre ilustrativo, que debe reemplazarse.
Los usos vigentes están en [storage.tf](../../storage.tf); los nombres reales se derivan de la
cuenta, región y prefijo.

## Entradas

| Nombre | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `name` | `string` | — | Nombre de un bucket que ya existe. **Contrato:** el bucket existe antes del apply |
| `versioning_enabled` | `bool` | `true` | Guarda versiones anteriores |
| `expiration_days` | `number` | `null` | Días enteros hasta que se borran los objetos, al menos 1 |
| `access_logs_bucket` | `string` | `null` | Bucket destino de los registros de acceso |
| `access_logs_prefix` | `string` | `""` | Prefijo de esos registros |
| `additional_policy_documents` | `list(string)` | `[]` | Políticas JSON que se suman a la base |

## Salidas

| Nombre | Descripción |
|---|---|
| `name` | Nombre del bucket. **Se entrega con el bucket listo para usar**: versionado (si corresponde) y política puestos. Es la salida para subir objetos o para mandarle registros de acceso |
| `arn` | ARN del bucket. **Se conoce en el plan y no espera a nada**: sirve para políticas e integraciones, que solo lo nombran. Para escribir en el bucket, usar `name` |

## Decisiones

- **El bucket se recibe, no se crea.** Ver arriba. Por eso no hay `force_destroy` ni `tags`: los dos
  eran atributos de `aws_s3_bucket`. El pipeline vacía y borra los buckets después del `destroy`. El
  ARN se arma con `data "aws_partition"`, que no consulta la API.

- **`count` para lo opcional.** Versionado, expiración y registros de acceso son recursos aparte en
  el provider 6 de AWS; crearlos solo cuando se piden evita configuraciones vacías.
- **`access_logs_bucket` recibe un nombre, no un id.** `count` tiene que poder evaluarse en el
  `plan`, y el id de un bucket que todavía no existe recién se conoce en el `apply`. Por eso quien
  llama al módulo debe garantizar que el destino y su política estén preparados. La raíz pasa
  `module.logs_bucket.name`, cuyo output espera al versionado y la política, sin depender de todo
  el módulo. Otras opciones del bucket no forman parte de esa garantía.
- **El output `name` espera al versionado y a la política** (`depends_on` en el output). Quien usa
  el nombre no ve esos recursos, y un objeto subido antes de activar el versionado quedaría sin
  `version_id`, que es lo que usa una Lambda para apuntar a su zip.
- **`depends_on` entre la política y el bloqueo de acceso público.** No hay referencia entre los dos,
  y S3 rechaza dos cambios de configuración simultáneos sobre el mismo bucket.
- **Las dos salidas tienen contratos distintos a propósito.** `arn` se arma del nombre y se conoce
  en el plan, así una política que lo nombra no espera a nada; `name` lleva el `depends_on`, porque
  es el que se usa para escribir.

## Tests

`terraform test` en esta carpeta, en modo plan y con el provider simulado: no necesita AWS. El
lockfile de esta carpeta fija sus providers; los tests corren desde el pipeline en los eventos
que ejecutan el job de validación.
