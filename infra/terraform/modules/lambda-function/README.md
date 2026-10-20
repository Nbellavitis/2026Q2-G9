# Módulo `lambda-function`

Una función Lambda en Node.js con las decisiones que comparten todas las de Queue.

- **El paquete se guarda versionado en el bucket de artefactos.** El bundle de esbuild se zipea con
  el datasource `archive_file`, se sube a `lambdas/<nombre>.zip` y la función apunta a esa versión
  exacta del objeto (`s3_object_version`). Cada carga del paquete genera una versión del objeto; la Lambda usa esa versión de S3, no un alias de versión publicada de Lambda.
- **Log group propio, con retención.** Si lo creara Lambda sola, no tendría retención y los logs se
  guardarían para siempre.
- **Rol recibido como entrada; la raíz usa `LabRole`.** El Learner Lab no permite crear roles, así que el rol se recibe como entrada
  en lugar de crearse acá.
- **arm64 por defecto.** El código es JavaScript puro, así que corre igual en Graviton, que cuesta
  menos por milisegundo.

## Uso

```hcl
module "public_example" {
  source = "./modules/lambda-function"

  name             = "q-public-example"
  source_file      = "../../functions/dist/public/index.mjs"
  role_arn         = data.aws_iam_role.lab.arn
  artifacts_bucket = module.private_buckets["artefactos"].name
  environment      = { TABLE_NAME = module.main_table.dynamodb_table_id }
}
```

El ejemplo supone ejecución desde la raíz Terraform, bundles compilados y el bucket de artefactos
configurado con versionado. Las llamadas vigentes están en [functions.tf](../../functions.tf) y
[auth.tf](../../auth.tf). El rol se recibe como entrada: `LabRole` es la elección de esta raíz,
no un nombre impuesto por el módulo.

## Entradas

| Nombre | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `name` | `string` | — | Nombre de la función |
| `description` | `string` | `""` | Descripción en la consola |
| `source_file` | `string` | — | Bundle de esbuild (`.mjs`) |
| `handler` | `string` | `"index.handler"` | Función que invoca Lambda |
| `runtime` | `string` | `"nodejs22.x"` | Runtime de Node.js |
| `architecture` | `string` | `"arm64"` | `arm64` o `x86_64` |
| `memory_size` | `number` | `256` | Memoria en MB, entera, de 128 a 10240 |
| `timeout` | `number` | `10` | Segundos enteros, de 1 a 900 |
| `environment` | `map(string)` | `{}` | Variables de entorno, nunca secretos |
| `role_arn` | `string` | — | Rol de ejecución (`LabRole`) |
| `artifacts_bucket` | `string` | — | Bucket versionado de artefactos |
| `log_retention_days` | `number` | `14` | Retención de los logs |
| `tags` | `map(string)` | `{}` | Tags propios |

## Salidas

| Nombre | Descripción |
|---|---|
| `name` | Nombre de la función |
| `arn` | ARN de la función |
| `invoke_arn` | ARN para integrarla con API Gateway |
| `log_group_name` | Log group de la función |
| `source_code_hash` | Hash del bundle desplegado: cambia cuando cambia el código. Lo usa la carga de demo para volver a correr |

## Decisiones

- **`depends_on` hacia el log group.** La función escribe en `/aws/lambda/<nombre>` por convención,
  sin referenciar al recurso. Sin `depends_on`, una invocación temprana haría que Lambda creara el
  log group sola, y el siguiente `apply` fallaría al intentar crearlo.
- **`dynamic "environment"`.** El bloque solo se genera si hay variables: un bloque vacío hace que
  el provider muestre un cambio en cada `plan`.

## Tests

`terraform test` en esta carpeta, en modo plan y con el provider simulado: no necesita AWS. El
lockfile de esta carpeta fija sus providers; los tests corren desde el pipeline en los eventos
que ejecutan el job de validación.
