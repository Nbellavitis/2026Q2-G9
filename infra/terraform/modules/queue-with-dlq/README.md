# Módulo `queue-with-dlq`

Una cola SQS de trabajo con DLQ, redrive, permisos de publicación y alarmas.

| Siempre | Opcional |
|---|---|
| DLQ propia, FIFO si la cola es FIFO | Permiso para que ciertos tópicos SNS publiquen (`publisher_topic_arns`) |
| Tope de intentos (`max_receive_count`) antes de pasar a la DLQ | Alarma si el mensaje más viejo espera demasiado (`max_message_age_seconds`) |
| La DLQ solo acepta mensajes de su cola | |
| Alarma de mensajes visibles en la DLQ, evaluada cada 60 segundos | |
| Cola y DLQ cifradas en reposo con la clave de SQS (SSE-SQS) | |

## Uso

```hcl
module "notifications" {
  source = "./modules/queue-with-dlq"

  name                       = "q-notifications"
  visibility_timeout_seconds = 180
  publisher_topic_arns       = [aws_sns_topic.queue_events.arn]
  alarm_topic_arn            = aws_sns_topic.alerts.arn
}
```

El ejemplo se evalúa desde la raíz Terraform, donde existen los tópicos referenciados.
El uso vigente de las tres colas está en [events.tf](../../events.tf). El módulo configura
visibilidad, pero no la deriva del timeout de una Lambda: la raíz pasa seis veces el timeout
del consumidor.

## Entradas

| Nombre | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `name` | `string` | — | Nombre, sin `.fifo` |
| `fifo` | `bool` | `false` | Cola FIFO |
| `visibility_timeout_seconds` | `number` | — | Visibilidad calculada por quien llama al módulo. Entero, de 0 a 43200 |
| `max_receive_count` | `number` | `5` | Intentos antes de la DLQ. Entero, de 1 a 1000 |
| `message_retention_seconds` | `number` | 4 días | Retención en la cola. Entero, de 60 s a 14 días |
| `dlq_retention_seconds` | `number` | 14 días | Retención en la DLQ. **Mayor que la de la cola** |
| `publisher_topic_arns` | `list(string)` | `[]` | Tópicos SNS que pueden publicar |
| `alarm_topic_arn` | `string` | — | Destino de las alarmas |
| `max_message_age_seconds` | `number` | `null` | Umbral de atraso del consumidor, en segundos enteros. `null`: sin alarma |
| `tags` | `map(string)` | `{}` | Tags propios |

## Salidas

| Nombre | Descripción |
|---|---|
| `arn` / `url` / `name` | La cola |
| `dlq_arn` / `dlq_url` | La DLQ |

## Decisiones

- **El tope de recepciones no es opcional.** Permite mover un mensaje repetidamente fallido a la
  DLQ antes de agotar su retención. No equivale al número de intentos internos de una notificación.
- **Las alarmas necesitan un receptor operativo.** Se publican al tópico indicado; para email hay
  que configurar y confirmar la suscripción SNS. El umbral de edad de 10 segundos en push se evalúa
  en períodos de 60 segundos, no garantiza una alerta a los 10 segundos.
- **La DLQ no recupera errores reconocidos como éxito.** Los consumidores deben reportar las fallas
  que quieran reintentar. Los errores WebSocket por conexión actualmente se registran y absorben.
- **La política de la cola solo admite los tópicos indicados**, con la condición `aws:SourceArn`:
  ningún otro tópico, de esta cuenta o de otra, puede publicar.
- **`count` para lo opcional:** la política existe solo si hay publicadores, y la alarma de atraso
  solo si se pide.
- **La DLQ guarda más tiempo que su cola, y se valida.** En una cola estándar, un mensaje conserva
  su antigüedad al pasar a la DLQ: una retención igual o menor reduce el tiempo disponible para
  investigarlo y puede hacer que venza poco después de llegar.

## Tests

`terraform test` en esta carpeta, en modo plan y con el provider simulado: no necesita AWS. El
lockfile de esta carpeta fija sus providers; los tests corren desde el pipeline en los eventos
que ejecutan el job de validación.
