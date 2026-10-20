# Queue — Tercera Entrega (IaC con Terraform)

ITBA 82.08 Cloud Computing · Grupo 9.

Queue es una plataforma de filas virtuales para restaurantes, comercios y cualquier mostrador donde
la gente espera. El cliente escanea un QR, se anota con su nombre y un mail, y sigue su turno desde
el celular. El staff maneja la fila desde un panel.

En esta entrega la arquitectura del TP2 (Spring Boot en EC2 detrás de un balanceador, con RDS) pasó
a ser **serverless**: Lambdas sobre DynamoDB, detrás de API Gateway. Se despliega **entera con
Terraform desde un pipeline de GitHub Actions**, en una cuenta de AWS Academy Learner Lab.

## Dónde está cada punto de la consigna

| Consigna | Sección |
|---|---|
| Archivos Terraform completos | [`infra/terraform/`](infra/terraform/) · [Terraform](#4-terraform) |
| Implementación de correcciones previas | [Correcciones del TP2](#8-correcciones-del-tp2) |
| Mínimo un módulo propio y uno externo | [Módulos](#42-módulos) |
| Variables y outputs | [Variables y outputs](#46-variables-y-outputs) |
| Al menos 4 funciones | [Funciones](#43-funciones) |
| Al menos 3 meta-argumentos | [Meta-argumentos](#44-meta-argumentos) |
| Organización, nomenclatura y DRY | [Archivos](#41-versiones-y-archivos) · [Locals y datasources](#45-locals-y-datasources) |
| Diagrama de arquitectura actualizado | [Arquitectura](#2-arquitectura) |
| Guía paso a paso para ejecución | [Guía paso a paso](#6-guía-paso-a-paso) |
| Pipeline con init, validate, plan, apply y destroy | [Pipeline](#5-pipeline-de-github-actions) |

---

## 1. La aplicación

| Funcionalidad | Cómo se resuelve |
|---|---|
| Ingreso por QR | Cada cola tiene un QR que abre su página; el cliente se anota con su nombre y un mail |
| Seguimiento de la espera | La página del ticket muestra posición, gente adelante y espera estimada, y se actualiza sola por WebSocket |
| Notificaciones | Avisos por mail al anotarse, al acercarse el turno (por posición o por minutos) y cuando le toca |
| Gestión de la fila | Tablero del staff: llamar, atender, ausente, pausar, cerrar; carriles por tamaño de grupo; métricas |
| Abandono y gracia | El cliente puede salir de la fila; si no se presenta, un período de gracia y una política de ausencia deciden qué pasa |
| Idiomas | Castellano e inglés, según el navegador; los mails llegan en el idioma en que se anotó el cliente |

---

## 2. Arquitectura

![Arquitectura de Queue en AWS](docs/diagrams/arquitectura.png)

Cada nodo del diagrama es un recurso que crea este Terraform. El diagrama se genera desde código
([`docs/diagrams/arquitectura.py`](docs/diagrams/arquitectura.py)), así que se actualiza junto con
la infraestructura.

| Servicio | Para qué |
|---|---|
| API Gateway REST | Una sola URL HTTPS para el sitio (leído del bucket privado con `LabRole`) y para la API `/api/v1`. Throttling por ruta |
| API Gateway WebSocket | Actualizaciones en vivo del tablero y del ticket |
| Lambda (9 funciones, Node 22) | `public` y `staff` atienden la API; `ws-connections` maneja los sockets; `stream-publisher`, `broadcaster`, `notifier` y `lifecycle` procesan eventos; `cognito-pre-signup` confirma las altas y `seed` carga la demo |
| DynamoDB | `q-main`, tabla única con todo el negocio y Streams; `q-connections`, los sockets abiertos |
| SNS FIFO y SQS | El bus de eventos: cada cambio de una cola se publica en orden y se reparte a tres colas, cada una con su DLQ |
| Cognito | Cuentas del staff. API Gateway valida el token sin invocar ninguna Lambda |
| Secrets Manager | La contraseña del SMTP de Gmail para los mails (ver [Mails](#7-mails)) |
| S3 | Tres buckets privados: el sitio, el código de las Lambdas y los logs de acceso. Más el del estado de Terraform |
| CloudWatch | Logs de las funciones y alarmas (mensajes en una DLQ, cola atrasada, fallas del stream) que avisan por SNS |

**Cómo fluye un cambio.** Toda escritura es una transacción en `q-main` que guarda el cambio y su
evento juntos. El stream de la tabla lleva el evento a `stream-publisher`, que lo publica en SNS FIFO
(en orden por cola). De ahí salen tres colas SQS: `q-push` (el `broadcaster` empuja la vista nueva
por WebSocket), `q-notifications` (el `notifier` decide y manda los mails) y `q-lifecycle` (vence
los períodos de gracia y libera las colas cerradas).

**Sin VPC.** No hay servidores ni bases con IP privada que proteger: todos los servicios son
regionales y administrados por AWS (multi-AZ), y las funciones los usan por HTTPS, autorizadas por
IAM con el rol `LabRole`. Una VPC solo agregaría un NAT Gateway o endpoints para salir hacia esos
mismos servicios, sin aislar nada.

**Restricciones del Learner Lab** que moldearon el diseño: solo existe `LabRole` (no se pueden
crear roles), CloudFront está bloqueado (por eso el sitio lo sirve API Gateway), SES está negado (por
eso los mails salen por Gmail) y un SCP impide crear buckets con `aws_s3_bucket` (ver
[Lo que no crea Terraform](#48-lo-que-no-crea-terraform-y-por-qué)).

La [arquitectura detallada](docs/architecture.md) explica cada decisión, la concurrencia y el
modelo de seguridad.

---

## 3. Estructura del repositorio

```
infra/terraform/      toda la infraestructura (esta entrega)
  modules/            los tres módulos propios, cada uno con README y tests
  scripts/buckets.sh  crea y borra los buckets de la app (ver 4.8)
  seed/demo.json      los datos de demo
  tests/              terraform test de la raíz
.github/
  workflows/terraform.yml          el pipeline
  actions/terraform-init/          init con el backend remoto, compartido por plan, apply y destroy
  scripts/smoke-realtime.mjs       la prueba de humo del WebSocket
functions/            las Lambdas en TypeScript: src/handlers (una por función), src/domain, tests
frontend/             el sitio (Next.js exportado como archivos estáticos)
docs/                 documentación de referencia y el diagrama
tp2/                  la entrega del TP2, como quedó
```

---

## 4. Terraform

### 4.1 Versiones y archivos

El pipeline usa Terraform `1.16.4`; la configuración admite `>=1.10.0, <2.0.0` porque usa el bloqueo
nativo de S3. [`versions.tf`](infra/terraform/versions.tf) fija los providers AWS `~>6.67.0`,
Archive `~>2.8.0` y Random `~>3.9.0`, y el [lockfile](infra/terraform/.terraform.lock.hcl) versionado
fija las versiones exactas y sus checksums.

Los archivos están separados por responsabilidad:

| Archivos | Qué tienen |
|---|---|
| `versions.tf`, `providers.tf`, `backend.tf` | Versiones, región, tags comunes y estado remoto |
| `variables.tf`, `outputs.tf`, `locals.tf`, `data.tf` | Interfaz, valores derivados y lo que ya existe en la cuenta |
| `storage.tf`, `site.tf` | Configuración de los buckets, objetos del sitio y `config.json` |
| `tables.tf` | Las dos tablas de DynamoDB (módulo externo) |
| `functions.tf`, `auth.tf` | Lambdas, sus disparadores SQS y Cognito |
| `api.tf`, `openapi.tf`, `realtime.tf` | API REST (desde un documento OpenAPI) y API WebSocket |
| `events.tf`, `monitoring.tf`, `notifications.tf` | Bus de eventos, alarmas, secreto SMTP e identidades SES opcionales |
| `seed.tf`, `seed/demo.json` | Usuario y datos de demo |

Todos los nombres salen de `var.project` (`q` por defecto) con `format`, y los de los buckets llevan
además la cuenta y la región, así no chocan en ninguna cuenta.

### 4.2 Módulos

| Módulo | Tipo | Se usa en | Qué encapsula |
|---|---|---|---|
| [`lambda-function`](infra/terraform/modules/lambda-function/README.md) | Propio | 9 funciones (`functions.tf`, `auth.tf`) | Empaqueta el bundle (`archive_file`), lo sube versionado al bucket de código, crea la función y su log group con retención. Devuelve nombre, ARN, ARN de invocación y hash del código |
| [`private-bucket`](infra/terraform/modules/private-bucket/README.md) | Propio | 3 buckets (`storage.tf`) | Sobre un bucket existente: bloqueo de acceso público, propiedad de objetos, versionado, ciclo de vida y logs opcionales, y una política que exige TLS |
| [`queue-with-dlq`](infra/terraform/modules/queue-with-dlq/README.md) | Propio | 3 colas (`events.tf`) | Cola estándar o FIFO con su DLQ, redrive, permiso para que SNS publique y alarmas de DLQ y de atraso |
| [`terraform-aws-modules/dynamodb-table/aws`](https://registry.terraform.io/modules/terraform-aws-modules/dynamodb-table/aws/5.5.2) | Externo, versión `5.5.2` fija | 2 tablas (`tables.tf`) | Claves, índice secundario, TTL, Streams y PITR |

Cada módulo propio tiene su README con entradas y salidas, y sus propios tests. Las funciones están
en dos instancias del módulo (`api_functions` y `workers`) para evitar un ciclo: la API REST
depende de las funciones de la API, y algunos workers necesitan la URL de esa API.

El plan muestra un aviso de deprecación de `hash_key`: sale del módulo externo, que en la versión
5.5.2 todavía declara así las claves de las tablas. No cambia lo que se crea.

### 4.3 Funciones

Se usan más de 30 funciones de Terraform. Las principales, con un ejemplo real de cada una:

| Función | Ejemplo | Dónde y para qué |
|---|---|---|
| `jsonencode` | `jsonencode(local.openapi)` | `api.tf`: la API REST entera sale de un documento OpenAPI generado con expresiones `for` desde una tabla de rutas. También políticas y filtros |
| `jsondecode`, `file` | `jsondecode(file("${path.module}/seed/demo.json"))` | `locals.tf`: los datos de demo vienen de un JSON versionado |
| `fileset` | `fileset(var.site_dir, "**")` | `locals.tf`: descubre los archivos del build del sitio sin listarlos a mano |
| `filemd5` | `filemd5("${var.site_dir}/${each.value}")` | `site.tf`: re-sube un archivo solo si cambió |
| `lookup` | `lookup(local.mime_types, lower(regex("[^.]+$", each.value)), "application/octet-stream")` | `site.tf`: el tipo MIME por extensión, con un valor por defecto |
| `sha1` | `sha1(aws_api_gateway_rest_api.this.body)` | `api.tf`: un deployment nuevo de la API cuando cambia su definición |
| `merge` | `merge(local.logged_bucket_names, { logs = format(...) })` | `locals.tf`: compone los nombres de los buckets sin repetir la regla |
| `format` | `format("%s-main", var.project)` | En todos los archivos: nombres a partir del prefijo |
| `toset`, `distinct` | `toset(distinct([for route in values(local.api_routes) : route.function]))` | `api.tf`: un permiso de invocación por función, aunque atienda muchas rutas |
| `try` | `try(aws_secretsmanager_secret.smtp[0].arn, "")` | `locals.tf`: el entorno de la función sirve aunque el secreto opcional no exista |
| `can`, `regex` | `can(regex(local.email_pattern, var.alert_email))` | `variables.tf`: validar mails y formatos |
| `split`, `lower`, `regexall` | `lower(split(" ", route)[0])` | `openapi.tf`: separar método y ruta, y extraer los parámetros de path |
| `fileexists` | `fileexists("${var.site_dir}/404.html")` | `openapi.tf`: usar la página 404 del build si existe |

### 4.4 Meta-argumentos

Se usan los cuatro:

| Meta-argumento | Ejemplo | Para qué |
|---|---|---|
| `for_each` | `for_each = local.queues` en `events.tf` | Una cola por clave del mapa (`push`, `notifications`, `lifecycle`). También las funciones, los buckets, los objetos del sitio, las rutas y las suscripciones |
| `count` | `count = var.demo_enabled ? 1 : 0` en `seed.tf` | Recursos opcionales: los datos de demo, la suscripción de alarmas, el secreto SMTP y las opciones de los módulos |
| `depends_on` | `depends_on = [aws_cloudwatch_log_group.this]` en `modules/lambda-function/main.tf` | Dependencias que ninguna referencia expresa: el log group antes de la función, y el permiso del trigger de Cognito antes de crear el usuario de demo |
| `lifecycle` | `create_before_destroy = true` en `api.tf` y `realtime.tf` | El deployment nuevo de cada API existe antes de borrar el que usa el stage, así la API no queda sin servir |

### 4.5 Locals y datasources

[`locals.tf`](infra/terraform/locals.tf) deriva todo lo que no es una entrada: el sufijo de cuenta y
región, los tags, los nombres de los buckets, los mapas de funciones y de colas, los datos de demo y
los objetos del sitio con su tipo MIME. [`openapi.tf`](infra/terraform/openapi.tf) arma las 35 rutas
de la API desde dos listas: sumar un endpoint es sumar una línea.

| Datasource | Para qué |
|---|---|
| `aws_caller_identity`, `aws_region`, `aws_partition` | Cuenta, región y partición sin escribirlas en el código |
| `aws_iam_role` | El `LabRole` que ya existe en el lab; Terraform no crea roles |
| `aws_iam_policy_document` | Políticas de los buckets y de las colas, como estructura y no como JSON a mano |
| `archive_file` | Empaquetar el bundle de cada función y obtener su hash |

### 4.6 Variables y outputs

Ninguna variable es obligatoria: con los valores por defecto se despliega en cualquier cuenta del
lab. Todas tienen tipo y descripción, y casi todas validación.

| Variable | Default | Qué controla |
|---|---|---|
| `region` | `us-east-1` | Región (el lab habilita `us-east-1` y `us-west-2`) |
| `project` | `q` | Prefijo de todos los nombres |
| `lab_role_name` | `LabRole` | El rol del lab |
| `api_stage_name` | `prod` | Stage de la API, que también es la ruta base del sitio |
| `site_dir`, `functions_dist_dir` | `../../frontend/out`, `../../functions/dist` | Dónde están los builds |
| `log_retention_days`, `access_logs_expiration_days` | `14`, `30` | Retención de logs |
| `site_throttle_*`, `api_throttle_*`, `public_write_*` | — | Límites de pedidos del sitio, de la API y de las rutas anónimas |
| `joins_per_minute` | `60` | Ingresos a una cola por IP y por minuto |
| `session_hours` | `12` | Duración de la sesión del staff |
| `demo_enabled`, `demo_email` | `true`, `demo@queue.example` | Datos y usuario de demo |
| `alert_email` | `null` | Mail que recibe las alarmas |
| `consumer_max_concurrency` | `2` | Ejecuciones simultáneas de cada consumidor |
| `smtp_sender_email` | `null` | Cuenta de Gmail que manda los mails |
| `ses_sender_email`, `ses_verified_recipients` | `null`, `[]` | SES, para una cuenta donde esté permitido |

Outputs: `site_url`, `health_url`, `websocket_url`, `user_pool_id` y `user_pool_client_id` (acceso);
`demo_queue_url`, `demo_staff_email` y `demo_staff_password` (sensitive); `bucket_names`,
`main_table_name`, `connections_table_name`, `function_names`, `stream_mapping_uuid`,
`smtp_secret_id` y `smtp_sender_email` (operación).

### 4.7 Estado remoto y bloqueo

El estado vive en S3, en `tfstate-q-<cuenta>-<región>`, con la clave `queue/terraform.tfstate`
([`backend.tf`](infra/terraform/backend.tf)):

- El bucket lo crea la acción [`terraform-init`](.github/actions/terraform-init/action.yml) la
  primera vez que el pipeline corre en una cuenta, privado y versionado. Tiene que existir antes del
  `terraform init`, así que Terraform no puede crearlo. El nombre no está en el código: el pipeline lo
  pasa con `-backend-config`, y cada cuenta usa el suyo.
- El bloqueo es el **nativo de S3** (`use_lockfile = true`): al empezar, Terraform crea un
  `.tflock` con una escritura condicional, así dos ejecuciones no escriben el estado a la vez. No
  hace falta una tabla de DynamoDB.
- En el pipeline, además, apply y destroy comparten un grupo de concurrencia, y plan, apply y
  destroy esperan el lock hasta 10 minutos (`-lock-timeout=10m`) en vez de fallar.

### 4.8 Lo que no crea Terraform, y por qué

| Qué | Quién lo hace | Por qué |
|---|---|---|
| Los 3 buckets de la app | [`scripts/buckets.sh`](infra/terraform/scripts/buckets.sh), desde el pipeline, con los nombres que define Terraform | Después de crear un `aws_s3_bucket`, el provider lee su configuración de object lock y un SCP del lab niega esa lectura (`AccessDenied` con deny explícito). Terraform configura todo lo demás del bucket (módulo `private-bucket`) |
| El bucket del estado | La acción `terraform-init` | Tiene que existir antes del `init` |
| El valor de la contraseña SMTP | El job Apply, con la AWS CLI, después del apply | Por Terraform quedaría en texto plano en el plan guardado y en el estado |

---

## 5. Pipeline de GitHub Actions

[`.github/workflows/terraform.yml`](.github/workflows/terraform.yml) corre en el pull request:

| Job | Qué hace | Credenciales AWS |
|---|---|---|
| **Validar** | `terraform fmt -check`, `init -backend=false`, `validate`, `terraform test` (raíz y módulos, con providers simulados) y tflint | No |
| **Compilar** | Typecheck, tests y build de las funciones; build del sitio | No |
| **Plan** | `init` con el backend remoto y `terraform plan -out=tfplan`. Deja el plan como artefacto y como comentario en el PR | Sí |
| **Apply** | Espera la aprobación del environment `aws-lab`. Crea los buckets, aplica **el mismo plan guardado**, carga la contraseña SMTP y corre la prueba de humo | Sí |
| **Destroy** | Con la etiqueta `destroy` en el PR (también aprobado): `terraform destroy`, vacía y borra los buckets y, por último, el bucket del estado | Sí |

| Evento | Qué corre |
|---|---|
| Push al PR (abrirlo, actualizarlo, reabrirlo) | Validar y Compilar → Plan → Apply (espera aprobación) |
| Etiqueta `destroy` en el PR | Destroy (espera aprobación) |
| *Run workflow* manual (`plan`, `apply` o `destroy`) | Lo elegido; solo si el workflow ya está en la rama por defecto |

**La prueba de humo** comprueba después de cada apply que `/api/v1/health` responde (la función lee
y escribe en DynamoDB), que el sitio y `config.json` cargan, que una ruta inexistente da la página
404, y que un cliente puede anotarse en la cola de demo y que un cambio en su ticket le llega por
WebSocket.

---

## 6. Guía paso a paso

Todo corre en GitHub Actions: no hace falta instalar nada. La
[guía de despliegue detallada](docs/deployment.md) tiene los resultados esperados de cada paso y qué
hacer si algo falla.

**Una sola vez, en el repositorio:**

1. *Settings → Environments*: crear `aws-lab` y agregar revisores obligatorios (sin revisores, el
   apply corre sin esperar aprobación).
2. *Issues → Labels*: crear la etiqueta `destroy`.

**En cada sesión del Learner Lab** (las credenciales vencen con la sesión):

3. Iniciar el lab, abrir *AWS Details* y copiar los tres valores en *Settings → Secrets and variables
   → Actions → Secrets*: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN`.

**Desplegar:**

4. Abrir un pull request desde una rama **del mismo repositorio** (un PR desde un fork no recibe los
   secrets), o hacer push a uno abierto. Si las credenciales cambiaron, *Re-run all jobs* en la
   última ejecución.
5. Esperar Validar, Compilar y Plan, y revisar el plan (artefacto o comentario del PR).
6. *Review deployments → aws-lab → Approve*. El job Apply crea todo y corre la prueba de humo.
7. El resumen del job Apply tiene la URL del sitio, la de la cola de demo y el usuario de demo.

**Usar la app:**

8. Abrir la cola de demo y anotarse como cliente; en otra ventana, registrar una cuenta de staff
   desde el sitio (o usar la de demo, cuya contraseña se lee como explica la
   [guía](docs/deployment.md#outputs-and-demo-credentials)) y llamar al siguiente desde el tablero.
   El ticket del cliente se actualiza solo.

**Destruir y volver a desplegar:**

9. Cancelar cualquier apply que haya quedado esperando aprobación, agregar la etiqueta `destroy` al
   PR y aprobar. En el log tiene que aparecer `Destroy complete!` y una línea `Vaciando y borrando:`
   por cada bucket.
10. Quitar la etiqueta. Para desplegar de nuevo, *Re-run all jobs* en la última ejecución del PR y
    aprobar el apply.

**Opcional, mails reales y alarmas** (sin esto, los mails se simulan en los logs):

| Dónde | Nombre | Valor |
|---|---|---|
| Variable del repositorio | `SMTP_SENDER_EMAIL` | La cuenta de Gmail que manda los mails |
| Secret del repositorio | `GMAIL_APP_PASSWORD` | Una [contraseña de aplicación](https://support.google.com/accounts/answer/185833) de esa cuenta |
| Variable del repositorio | `ALERT_EMAIL` | Quién recibe las alarmas; hay que confirmar el mail de suscripción que manda AWS |

---

## 7. Mails

**El Learner Lab niega SES**: `ses:SendEmail`, `ses:CreateEmailIdentity` y `ses:VerifyEmailIdentity`
tienen un deny explícito. Por eso los mails salen por el **SMTP de Gmail** (`smtp.gmail.com:465`,
sobre TLS) desde la cuenta del grupo, y llegan a cualquier dirección.

La contraseña de aplicación de esa cuenta es el único secreto del sistema, y se maneja como tal:
está en el secret de GitHub y en Secrets Manager (cifrada), nunca en un archivo, en el repositorio,
en el plan ni en el estado de Terraform. Terraform crea el secreto vacío y el job Apply le carga el
valor con la CLI. El `notifier` lo lee al mandar.

Sin `SMTP_SENDER_EMAIL`, el `notifier` escribe cada mail en su log de CloudWatch (`emailSimulado`),
lo que la consigna permite. El código de SES sigue disponible para una cuenta donde esté permitido.

---

## 8. Correcciones del TP2

| Corrección | Cómo quedó |
|---|---|
| **Separar el bucket privado en tres** | `spa` (el sitio), `artifacts` (el código de las Lambdas, versionado) y `logs` (registros de acceso de los otros dos). Los tres privados, con TLS obligatorio, por el módulo `private-bucket` |
| **«Falta encriptar»: contraseñas en texto plano en el `.env`** | Ninguna contraseña vive en un archivo de configuración: Cognito reemplazó el JWT propio, DynamoDB no tiene contraseña y los servicios se usan con IAM. El único secreto (la contraseña de Gmail) está cifrado en Secrets Manager y fuera del estado de Terraform |
| **Justificar RDS con el nuevo cómputo** | Se reemplazó por DynamoDB. Con Lambda, RDS obligaría a una VPC, a un NAT y a una contraseña, y cobra aunque nadie use la app. Todo acceso es por cola, que encaja con una partición por cola; la concurrencia se resuelve con una versión por cola y transacciones |
| **Justificar el pub/sub con el nuevo cómputo** | El `LISTEN/NOTIFY` de PostgreSQL coordinaba varias instancias de EC2. Sin servidores, cada cambio se publica desde el stream de DynamoDB en SNS FIFO (en orden por cola) y se reparte a colas SQS, cada una con su consumidor, su DLQ y su alarma |
| **Desplegar con IaC** | Todo con Terraform desde el pipeline, con estado remoto, plan guardado y aprobación |

---

## 9. Seguridad: hallazgos de tfsec

El repositorio de la entrega corre [tfsec](https://github.com/aquasecurity/tfsec) en cada pull
request. Lo que marca sobre esta configuración, y qué se decidió con cada cosa:

| Hallazgo | Decisión |
|---|---|
| Colas SQS sin cifrar (HIGH) | **Resuelto.** Las tres colas, sus DLQs y la de fallas del stream declaran `sqs_managed_sse_enabled = true`: cifrado en reposo con la clave que administra SQS, sin KMS ni costo |
| Tablas DynamoDB sin cifrado (HIGH) | DynamoDB cifra **siempre** en reposo, con una clave de AWS. tfsec pide además una clave KMS, que agrega costo por pedido y no cambia qué datos quedan protegidos |
| Tópicos SNS sin cifrar (HIGH) | Un mensaje vive en SNS solo hasta entregarse a las colas SQS, que sí están cifradas. En `q-alerts`, además, las alarmas de CloudWatch no pueden publicar en un tópico cifrado con la clave administrada de AWS: harían falta una clave KMS propia y su política |
| API Gateway sin access logs (MEDIUM) | Cada función deja sus logs en CloudWatch, y API Gateway publica sus métricas. Los access logs necesitan un rol de CloudWatch para toda la cuenta, que no se probó en el Learner Lab |
| `q-connections` sin PITR (MEDIUM) | A propósito: guarda sockets abiertos que vencen en dos horas, no hay nada que recuperar. `q-main`, la que tiene los datos del negocio, sí tiene PITR |
| Sin caché en la API (LOW) | Las respuestas cambian con cada movimiento de la fila, y la caché de API Gateway se cobra por hora |
| Sin trazas de X-Ray (LOW) | X-Ray no fue parte de la cursada; los logs de cada función alcanzan para seguir un pedido |
| Log groups sin clave propia (LOW) | CloudWatch Logs ya cifra en reposo; una clave KMS propia solo cambiaría quién la administra |

---

## 10. Tests y verificación local

```bash
cd functions && npm ci && npm test        # unitarios e integración (necesita Docker: DynamoDB Local)
```

```bash
cd infra/terraform
terraform fmt -check -recursive
terraform init -backend=false && terraform validate
terraform test                            # en modo plan, con providers simulados: no usa AWS
tflint --init && tflint --recursive
```

Los tests de Terraform comprueban que la configuración entera planifica con los valores por defecto,
los contratos de cada módulo y que las validaciones rechazan entradas inválidas. Cada módulo tiene los
suyos en `modules/*/tests`. El pipeline corre todo esto en cada push.

---

## 11. Documentación adicional

| Documento | Contenido |
|---|---|
| [docs/deployment.md](docs/deployment.md) | El despliegue en detalle: resultados esperados, recuperación, solución de problemas |
| [docs/architecture.md](docs/architecture.md) | Las decisiones de arquitectura, la concurrencia, los eventos y la seguridad |
| [docs/gotchas.md](docs/gotchas.md) | Lo que el Learner Lab no permite y las trampas del pipeline |
| [docs/domain-model.md](docs/domain-model.md) | Las entidades y sus ítems de DynamoDB, la máquina de estados de una entrada |
| [docs/api-reference.md](docs/api-reference.md) | Cada endpoint y el contrato del WebSocket |
| [docs/frontend.md](docs/frontend.md) | Notas del frontend |
| [docs/historial/](docs/historial/) | Documentos de trabajo de la entrega: la propuesta serverless, el roadmap y el registro de avance |
| [tp2/](tp2/) | La entrega del TP2: plantilla de CloudFormation y diagrama |
