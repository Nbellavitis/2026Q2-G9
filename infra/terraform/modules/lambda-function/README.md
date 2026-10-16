# Módulo `lambda-function`

Una función Lambda en Node.js con las decisiones que comparten todas las de Queue.

- **El paquete se guarda versionado en el bucket de artefactos.** El bundle de esbuild se zipea con
  el datasource `archive_file`, se sube a `lambdas/<nombre>.zip` y la función apunta a esa versión
  exacta del objeto (`s3_object_version`). Cada despliegue queda registrado como una versión.
- **Log group propio, con retención.** Si lo creara Lambda sola, no tendría retención y los logs se
  guardarían para siempre.
- **Siempre `LabRole`.** El Learner Lab no permite crear roles, así que el rol se recibe como entrada
  en lugar de crearse acá.
- **arm64 por defecto.** El código es JavaScript puro, así que corre igual en Graviton, que cuesta
  menos por milisegundo.

## Uso

```hcl
module "health" {
  source = "./modules/lambda-function"

  name             = "q-health"
  source_file      = "../../functions/dist/health/index.mjs"
  role_arn         = data.aws_iam_role.lab.arn
  artifacts_bucket = module.artefactos.name
  environment      = { TABLE_NAME = "q-main" }
}
```

## Entradas

| Nombre | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `name` | `string` | — | Nombre de la función |
| `description` | `string` | `""` | Descripción en la consola |
| `source_file` | `string` | — | Bundle de esbuild (`.mjs`) |
| `handler` | `string` | `"index.handler"` | Función que invoca Lambda |
| `runtime` | `string` | `"nodejs22.x"` | Runtime de Node.js |
| `architecture` | `string` | `"arm64"` | `arm64` o `x86_64` |
| `memory_size` | `number` | `256` | Memoria en MB |
| `timeout` | `number` | `10` | Segundos |
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

## Decisiones

- **`depends_on` hacia el log group.** La función escribe en `/aws/lambda/<nombre>` por convención,
  sin referenciar al recurso. Sin `depends_on`, una invocación temprana haría que Lambda creara el
  log group sola, y el siguiente `apply` fallaría al intentar crearlo.
- **`dynamic "environment"`.** El bloque solo se genera si hay variables: un bloque vacío hace que
  el provider muestre un cambio en cada `plan`.
