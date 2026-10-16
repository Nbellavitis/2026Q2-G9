import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyResult } from 'aws-lambda'

/**
 * Prueba de humo de la cadena completa: API Gateway → Lambda → DynamoDB.
 *
 * Escribe un ítem y lo vuelve a leer con lectura fuertemente consistente. Si responde 200, la
 * función tiene permiso sobre la tabla (LabRole), la tabla existe y la API está bien enrutada. Es lo
 * que el pipeline consulta después de cada apply.
 *
 * El ítem vence solo en una hora por el TTL de la tabla, así que las pruebas no acumulan datos.
 */

const tableName = process.env.TABLE_NAME
const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const key = { PK: 'HEALTH', SK: 'PING' }
const ONE_HOUR_SECONDS = 3600

export const handler = async (): Promise<APIGatewayProxyResult> => {
  if (!tableName) {
    return respond(500, { status: 'error', reason: 'TABLE_NAME no está configurada' })
  }

  const wroteAt = new Date().toISOString()

  try {
    await documents.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...key, at: wroteAt, ttl: Math.floor(Date.now() / 1000) + ONE_HOUR_SECONDS },
      }),
    )

    const read = await documents.send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    )
    const readAt: unknown = read.Item?.['at']

    if (readAt !== wroteAt) {
      return respond(503, { status: 'error', reason: 'La lectura no devolvió lo escrito', wroteAt, readAt })
    }

    return respond(200, { status: 'ok', table: tableName, wroteAt })
  } catch (error) {
    console.error('Fallo la prueba contra DynamoDB', error)
    return respond(503, { status: 'error', reason: 'DynamoDB no respondió' })
  }
}

function respond(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  }
}
