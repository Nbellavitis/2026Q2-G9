# Módulo `queue-with-dlq`

Una cola SQS de trabajo con todo lo que la hace segura de operar.

| Siempre | Opcional |
|---|---|
| DLQ propia, FIFO si la cola es FIFO | Permiso para que ciertos tópicos SNS publiquen (`publisher_topic_arns`) |
| Tope de intentos (`max_receive_count`) antes de pasar a la DLQ | Alarma si el mensaje más viejo espera demasiado (`max_message_age_seconds`) |
| La DLQ solo acepta mensajes de su cola | |
| Alarma apenas cae un mensaje en la DLQ | |

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

## Entradas

| Nombre | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `name` | `string` | — | Nombre, sin `.fifo` |
| `fifo` | `bool` | `false` | Cola FIFO |
| `visibility_timeout_seconds` | `number` | — | 6 veces el timeout del consumidor |
| `max_receive_count` | `number` | `5` | Intentos antes de la DLQ |
| `message_retention_seconds` | `number` | 4 días | Retención en la cola |
| `dlq_retention_seconds` | `number` | 14 días | Retención en la DLQ |
| `publisher_topic_arns` | `list(string)` | `[]` | Tópicos SNS que pueden publicar |
| `alarm_topic_arn` | `string` | — | Destino de las alarmas |
| `max_message_age_seconds` | `number` | `null` | Umbral de atraso del consumidor |
| `tags` | `map(string)` | `{}` | Tags propios |

## Salidas

| Nombre | Descripción |
|---|---|
| `arn` / `url` / `name` | La cola |
| `dlq_arn` / `dlq_url` | La DLQ |

## Decisiones

- **El tope de intentos no es opcional.** Sin él, un mensaje que siempre falla se reintenta para
  siempre, y cada intento es una invocación que se paga.
- **La política de la cola solo admite los tópicos indicados**, con la condición `aws:SourceArn`:
  ningún otro tópico, de esta cuenta o de otra, puede publicar.
- **`count` para lo opcional:** la política existe solo si hay publicadores, y la alarma de atraso
  solo si se pide.
