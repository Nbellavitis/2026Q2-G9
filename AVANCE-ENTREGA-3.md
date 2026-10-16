# Avance de la entrega 3

Registro de lo hecho sobre la rama `entrega-3`, fase por fase, contra el [ROADMAP](ROADMAP.md). Cada
fase anota qué se construyó, qué se decidió en el camino y por qué, qué se verificó y qué falta.

| Fase | Estado |
|---|---|
| 1 · Esqueleto que camina: Terraform y pipeline | **Código completo y verificado localmente. Falta correrlo en el lab.** |
| 2 · Dominio y persistencia en DynamoDB | Pendiente |
| 3 · API síncrona y Cognito | Pendiente |
| 4 · Bus de eventos | Pendiente |
| 5 · Consumidores y tiempo real | Pendiente |
| 6 · Retirar lo anterior | Pendiente |
| 7 · Entrega | Pendiente |

---

## Fase 1 · Esqueleto que camina

### Qué se construyó

```
.github/
  actions/terraform-init/action.yml   credenciales, bucket del estado e init (compartido)
  workflows/terraform.yml             validate, build, plan, apply, destroy
functions/                            las Lambdas en TypeScript
  build.mjs                           esbuild: un bundle por handler
  src/handlers/health.ts              escribe y lee la tabla principal
infra/terraform/
  versions.tf · backend.tf · providers.tf
  variables.tf · locals.tf · data.tf · outputs.tf · terraform.tfvars.example
  storage.tf     los tres buckets privados
  tables.tf      la tabla principal, con el módulo externo
  functions.tf   las funciones, con el módulo propio
  site.tf        el build del frontend en el bucket del sitio
  api.tf         API REST: el sitio y /api/v1/health
  .tflint.hcl
  modules/private-bucket/             módulo propio, con README
  modules/lambda-function/            módulo propio, con README
frontend/next.config.ts               ruta base configurable
frontend/src/app/q/page.tsx           la navegación manual respeta la ruta base
```

Al desplegar queda andando:

| Recurso | Para qué |
|---|---|
| Buckets `q-spa-…`, `q-artefactos-…`, `q-logs-…` | Sitio, zips de las Lambdas (versionados), registros de acceso de los otros dos (expiran a 30 días) |
| Tabla `q-main` | La tabla definitiva: PK/SK genéricas, Streams, PITR y TTL |
| Función `q-health` | Prueba de humo de API Gateway → Lambda → DynamoDB |
| API REST `q-api`, stage `prod` | El sitio en `/prod/` y la salud en `/prod/api/v1/health` |

### Decisiones que se apartan del roadmap

1. **La tabla principal real en lugar de una tabla de prueba.** El diseño de §5 usa claves
   genéricas (`PK` y `SK` como strings), Streams, PITR y TTL: nada de eso cambia en las fases
   siguientes. Crearla ahora evita un recurso descartable y deja usado el módulo externo (10 % de
   la rúbrica) desde la primera fase. El ítem de la prueba de humo vence solo a la hora por TTL.
2. **Sin alias ni SnapStart.** Eran para Java. Con Node, API Gateway invoca la función directamente.
3. **Dos rutas para el sitio en lugar de una por página.** No está documentado cómo resuelve
   API Gateway REST un pedido como `/login/index.txt` cuando existen a la vez un recurso `/login` y
   un `/{proxy+}`, y Next pide esos `.txt` en cada navegación. En lugar de arriesgarlo, hay solo dos
   rutas (la raíz y `/{proxy+}`), y cada página se sube **además** con su ruta como clave, con y sin
   barra final: `login/index.html` también existe como `login/` y como `login`. Son 20 objetos más
   (108 en total) y ninguna regla de ruteo.
4. **Los zips de las funciones se guardan en el bucket de artefactos**, versionado, y cada función
   apunta a la versión exacta del objeto. Así el bucket tiene un uso real y cada despliegue queda
   registrado.
5. **El código de las Lambdas va en `functions/`**, separado de `backend/` (Java), que se retira en
   la Fase 6.
6. **La ruta base del frontend sale de `NEXT_PUBLIC_BASE_PATH`.** En desarrollo queda vacía; el
   pipeline compila con `/prod`. `NEXT_PUBLIC_API_URL=/prod` hace que la API se llame por la misma
   URL, sin tocar `api.ts`; la Fase 3 lo reemplaza por `config.json`.
7. **El pipeline aplica exactamente el plan revisado.** El plan se guarda como artefacto junto con
   los zips de las funciones (el plan los referencia y en otro runner no existirían), y el `apply`
   corre ese archivo, no un plan nuevo.
8. **Lo común a plan, apply y destroy está en una action propia** (`terraform-init`): instalar
   Terraform, cargar las credenciales, crear el bucket del estado si no existe e inicializar. Tres
   jobs, una sola definición.

### Versiones fijadas

Todas publicadas hace al menos dos semanas al momento de elegirlas.

| Pieza | Versión |
|---|---|
| Terraform | 1.16.4 (`required_version >= 1.10, < 2.0`) |
| Provider `hashicorp/aws` | 6.67.0 (`~> 6.67.0`) |
| Provider `hashicorp/archive` | 2.8.1 (`~> 2.8.0`) |
| Módulo `terraform-aws-modules/dynamodb-table/aws` | 5.5.2 |
| tflint / ruleset AWS | 0.64.0 / 0.49.0 |
| Runtime de Lambda | `nodejs22.x`, arm64 |
| esbuild / TypeScript | 0.28.2 / 5.9.3 |
| Actions | checkout 7.0.1 · setup-node 7.0.0 · setup-terraform 4.0.1 · configure-aws-credentials 6.3.0 · setup-tflint 6.3.1 · upload-artifact 7.0.1 · download-artifact 8.0.1 · github-script 9.0.0 |

`.terraform.lock.hcl` está commiteado con los hashes de Linux, macOS y Windows, así cualquiera del
grupo y la cátedra usan los mismos providers.

### Verificado localmente

| Qué | Resultado |
|---|---|
| `terraform fmt -check -recursive` | Sin diferencias |
| `terraform validate` | Válido |
| `tflint --recursive` (presets `terraform` y `aws`) | Sin advertencias |
| `actionlint` sobre el workflow y la action | Sin errores |
| `functions`: typecheck y build | Bundle de 1,5 KB |
| `health` contra DynamoDB Local | 200: escribe, relee con lectura fuerte y coincide |
| Frontend: typecheck y build con `NEXT_PUBLIC_BASE_PATH=/prod` | Assets en `/prod/_next/…`, la redirección al ticket incluye `/prod` |
| Locals del sitio contra el build real | 88 archivos → 108 objetos; todos los tipos de archivo tienen content-type |

### Sin verificar: necesita el lab

Ninguna de estas cosas se puede probar sin credenciales de AWS. Son lo primero a mirar en la primera
ejecución del pipeline.

| Riesgo | Cómo se nota | Plan B |
|---|---|---|
| `LabRole` no puede ser asumido por API Gateway para leer S3 | El sitio responde 500 y el log de ejecución de API Gateway dice que no puede asumir el rol | Servir el sitio desde una Lambda Node mínima |
| API Gateway recorta o conserva la barra final del `{proxy+}` | Solo afecta qué clave se pide; están subidas las dos | — |
| S3 no entrega los registros de acceso | El bucket de logs queda vacío tras usar el sitio | Revisar la política de entrega (`data.tf`) |
| El lab bloquea alguna acción (como pasó con `StartInstanceRefresh` en el TP2) | `AccessDenied` en el `apply` | Depende de cuál |
| Límite de concurrencia de Lambda | — | Anotarlo: `aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions` |

### Para correrlo por primera vez

Una sola vez, en el repositorio de GitHub (requiere permisos de administrador):

1. **Secrets** (*Settings → Secrets and variables → Actions*): `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN`, copiados de *AWS Details* en el Learner Lab. Se
   actualizan en cada sesión nueva del lab.
2. **Environment `aws-lab`** (*Settings → Environments*) con *Required reviewers*. Lo configura
   y aprueba Jose (`josebl123`), dueño del repositorio. Sin revisores, el
   `apply` corre solo en cada push al PR. El repositorio es público, así que GitHub lo permite sin
   plan pago.
3. **Etiqueta `destroy`** (*Issues → Labels*), para poder destruir desde el PR.

Después: abrir un PR desde `entrega-3`, esperar `validate`, `build` y `plan`, aprobar el `apply`
en la ejecución, y revisar el resumen con las URLs. Para limpiar la cuenta, agregar la etiqueta
`destroy` al PR y aprobar.

### Rúbrica: lo que ya está cubierto

| Criterio | Dónde |
|---|---|
| Módulos propios | `private-bucket` ×3 (`storage.tf`), `lambda-function` ×1 (`functions.tf`); cada uno con `README.md`, `versions.tf`, variables tipadas y validadas |
| Módulo externo | `terraform-aws-modules/dynamodb-table/aws` 5.5.2 (`tables.tf`) |
| `for_each` | `module.private_buckets`, `module.functions`, `aws_s3_object.site`, métodos, integraciones y respuestas del sitio (`api.tf`) |
| `count` | Versionado, expiración y registros de acceso opcionales dentro de `private-bucket` |
| `depends_on` | `module.private_buckets` → bucket de logs (`storage.tf`); política → bloqueo público (`private-bucket`); función → log group (`lambda-function`); output `name` → versionado y política (`private-bucket`); respuestas de integración → integraciones (`api.tf`). Cada uno con el motivo escrito al lado |
| `lifecycle` | `create_before_destroy` en el deployment de la API (`api.tf`) |
| Funciones | `format`, `merge`, `keys`, `values`, `fileset`, `endswith`, `startswith`, `trimsuffix`, `lookup`, `lower`, `regex`, `filemd5`, `setproduct`, `sha1`, `jsonencode`, `contains`, `can` |
| Locals | Sufijo de nombres, tags, mapa de buckets, mapa de funciones, tipos MIME, objetos del sitio, rutas del sitio y sus respuestas (`locals.tf`) |
| Datasources | `aws_caller_identity`, `aws_region`, `aws_iam_role` (`data.tf`); `aws_iam_policy_document` (`data.tf` y `private-bucket`); `archive_file` (`lambda-function`) |
| Calidad | `fmt`, `validate` y `tflint` en el pipeline; variables con `description` y `validation`; outputs con `description`; nada escrito a mano; un archivo por área |
