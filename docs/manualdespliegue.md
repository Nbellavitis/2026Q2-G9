# Manual de despliegue — Queue

ITBA 82.08 Cloud Computing · Grupo 9 · cuenta `625746291868` · región `us-east-1`

Todo se hace desde la consola de AWS Academy. Los scripts y las configuraciones que hacen falta
están acá adentro, listos para pegar.

**El orden está pensado para no volver atrás.** Cada paso solo necesita datos que ya existen cuando
llegás a él, y los 15–20 minutos que tarda RDS en crearse se usan para avanzar con lo que no depende
de ella. Si lo seguís en orden, no hay ningún momento en que tengas que volver a corregir algo hecho
antes.

> **Esta no es la arquitectura de `infra/q-stack.yaml`.** Esa plantilla usa CloudFront, y **el
> Learner Lab no lo habilita**. La sección *Diferencias con la arquitectura propuesta* explica qué
> cambió y qué se pierde. El diagrama de lo que efectivamente se despliega está en
> `diagramas/05-arquitectura-deploy-manual.svg`.

---

## Índice

| # | Paso | Necesita | Mientras tanto |
|---|---|---|---|
| 1 | Red: VPC, 6 subredes, IGW, NAT, tablas, Gateway Endpoint | — | |
| 2 | Security groups | 1 | |
| 3 | **RDS** — arrancar la creación y seguir | 1, 2 | **tarda 15–20 min** |
| 4 | Target group y ALB | 1, 2 | RDS se crea |
| 5 | Los dos buckets, con website hosting y policy | — | RDS se crea |
| 6 | Compilar y subir el frontend | 4, 5 | RDS se crea |
| 7 | Escribir y subir `app.env` y el jar | 3, 5 | |
| 8 | Launch template con user-data | 5, 7 | |
| 9 | Auto Scaling Group, horarios y políticas | 4, 8 | |
| 10 | Verificación | todo | |

**La única dependencia de orden que no es obvia:** el DNS del ALB queda compilado dentro del bundle
del frontend, y no se puede predecir. Por eso el ALB va antes que el frontend. El endpoint del sitio,
en cambio, **sí se puede saber de antemano** —se deriva del nombre de bucket que elegís vos—, así que
`app.env` se escribe una sola vez con su valor definitivo.

## Decidí estos nombres antes de empezar

De acá salen tres valores que aparecen en varios lugares. Cambiarlos después obliga a rehacer pasos.

```
Bucket de artefactos   queue-s3-625746291868-us-east-1-an        privado
Bucket del sitio       queue-web-625746291868-us-east-1-an       público
Endpoint del sitio     http://queue-web-625746291868-us-east-1-an.s3-website-us-east-1.amazonaws.com
```

El endpoint es `http://<bucket>.s3-website-us-east-1.amazonaws.com`. Sale del nombre, no hace falta
que el bucket exista todavía.

---

## 1. Red

**VPC → Create VPC → VPC only.** Nombre `q-vpc`, CIDR `10.0.0.0/16`.

Después **Subnets → Create subnet**, seis veces:

| Nombre | CIDR | AZ | Auto-assign public IP |
|---|---|---|---|
| `q-public-a` | `10.0.0.0/24` | us-east-1a | **Sí** |
| `q-public-b` | `10.0.1.0/24` | us-east-1b | **Sí** |
| `q-app-a` | `10.0.10.0/24` | us-east-1a | No |
| `q-app-b` | `10.0.11.0/24` | us-east-1b | No |
| `q-db-a` | `10.0.20.0/24` | us-east-1a | No |
| `q-db-b` | `10.0.21.0/24` | us-east-1b | No |

El segundo octeto marca la capa y el par/impar la zona, así que una IP se lee sola: `10.0.11.47` es
aplicación en la zona b.

**Internet Gateway** `q-igw`, y adjuntalo a la VPC (*Actions → Attach to VPC*). Crearlo no lo conecta.

**NAT Gateway** `q-nat`, en `q-public-a`, con una Elastic IP nueva. Tarda un par de minutos.

**Route tables**, tres:

| Tabla | Asociar a | Ruta |
|---|---|---|
| `q-rt-public` | `q-public-a`, `q-public-b` | `0.0.0.0/0` → Internet Gateway |
| `q-rt-app` | `q-app-a`, `q-app-b` | `0.0.0.0/0` → NAT Gateway |
| `q-rt-db` | `q-db-a`, `q-db-b` | **ninguna** |

La tercera fila es literal: solo la ruta local implícita de `10.0.0.0/16`. **No le agregues nada.**
Es la mitad de la demostración de aislamiento, y es lo que hace que `psql` desde afuera cuelgue en vez
de ser rechazado. Un timeout prueba que los paquetes nunca llegaron.

**VPC → Endpoints → Create endpoint.** Nombre `q-s3-endpoint`, servicio `com.amazonaws.us-east-1.s3`,
tipo **Gateway**, asociado a **`q-rt-app`**.

Sin esto las instancias igual bajan sus artefactos, pero salen por el NAT y se factura por GB.

## 2. Security groups

**EC2 → Security Groups.** Creá los tres **primero vacíos**: no podés referenciar un grupo que
todavía no existe.

| Grupo | Entrada | Puerto | Origen |
|---|---|---|---|
| `alb-sg` | HTTP | 80 | `0.0.0.0/0` |
| `api-sg` | Custom TCP | 8080 | **`alb-sg`** |
| `db-sg` | PostgreSQL | 5432 | **`api-sg`** |

Salida: **todo** en los cuatro, que es el default. Las capas privadas ya son inalcanzables desde
afuera; enumerar destinos por dirección es mantenimiento sin ganancia.

**Encadenados por id de grupo, nunca por CIDR.** Es tentador poner `10.0.10.0/24` en `db-sg` porque
es más fácil de tipear, pero pierde la demostración: encadenar por id prueba que la autorización es
por identidad y sigue valiendo aunque mañana muevas las subredes.

En `db-sg` lo que importa es lo que falta: **no hay ninguna otra fuente**. Estar dentro de la VPC no
alcanza para llegar a la base.

**No hace falta bastión.** Con user-data nadie entra a las instancias, y el log del arranque se sube
solo al bucket de artefactos (paso 8), que es de donde vas a diagnosticar. Si en algún momento
necesitás una sesión interactiva, ahí creás `bastion-sg` con SSH 22 desde tu IP `/32`, le agregás a
`api-sg` una entrada SSH 22 desde `bastion-sg`, y lanzás una `t3.micro` en `q-public-a`. Son dos
minutos y no condiciona nada de lo anterior.

### Por qué no hay una NACL

La plantilla del repositorio le pone una NACL propia a la capa de base. Acá no, y conviene que la
decisión esté escrita en vez de parecer un olvido.

Lo que aísla la base son **dos** cosas, y ninguna es la NACL: la tabla de ruteo no tiene salida de la
VPC, y `db-sg` solo acepta desde `sg-app`. Una NACL sería una tercera capa sobre dos que ya alcanzan.

Su único aporte real sería a nivel de subred: sobrevive a un error de configuración de un security
group, por ejemplo si alguien lanzara algo en las subredes de base con un grupo permisivo. **Ese
escenario supone más de una persona tocando la cuenta**, y no es el caso.

A cambio traería un modo de falla propio: las NACL **no tienen estado**, así que hay que agregar a
mano una regla de puertos efímeros para las respuestas. Sin ella la conexión abre y después cuelga,
que es de los síntomas más difíciles de diagnosticar.

Si el informe necesita mostrar el tema, la honestidad es decir esto mismo: se evaluó y se dejó afuera
porque el aislamiento ya está resuelto en la ruta y en el security group.

## 3. RDS — arrancala y seguí

**RDS → Create database → Standard create.**

| Ajuste | Valor |
|---|---|
| Engine | PostgreSQL 16 |
| Template | Dev/Test |
| Availability | **Multi-AZ DB instance** |
| Identifier | `queue-database` |
| Master username | `queue` |
| Master password | uno tuyo, anotalo |
| Class | `db.t3.micro` |
| Storage | 20 GB gp3 |
| VPC | `q-vpc` |
| Subnet group | crear uno nuevo con `q-db-a` y `q-db-b` |
| Public access | **No** |
| Security group | `db-sg` |
| **Initial database name** | **`queue_db`** |
| Backup retention | 0 días |

**El nombre de la base inicial no es opcional.** Si lo dejás vacío, RDS no crea ninguna base y la
aplicación va a fallar al conectar. Está en *Additional configuration*, colapsado por defecto.

PostgreSQL 16 importa: `LISTEN/NOTIFY` es lo que lleva las actualizaciones en vivo entre instancias.

**Dale a crear y seguí con el paso 4.** Tarda 15–20 minutos. Volvés a necesitarla recién en el paso 7,
para el endpoint.

### El techo de conexiones, para tenerlo presente

RDS calcula `max_connections` según la memoria: unas 110 en `db.t3.micro`. Cada instancia toma
`DB_POOL_MAX` conexiones **más una sesión `LISTEN` de larga duración**, que es la que se olvida:

```
max_instancias × (DB_POOL_MAX + 1)  ≤  80% de max_connections
```

Con un pool de 10, el techo seguro son 8 instancias. Subir el máximo del grupo sin subir la clase de
RDS la deja sin conexiones.

## 4. Target group y ALB

**EC2 → Target Groups → Create target group.**

| Ajuste | Valor |
|---|---|
| Target type | **Instances** |
| Nombre | `queue-tg` |
| Protocolo / puerto | **HTTP / 8080** |
| VPC | `q-vpc` |
| **Protocol version** | **HTTP1** |
| Health check path | **`/actuator/health/readiness`** |
| Intervalo / timeout | 15s / 5s |
| Umbral sano / no sano | 2 / 3 |
| Success codes | 200 |

Después de crearlo, en *Attributes*: **Deregistration delay 30s**.

**No registres ninguna instancia todavía**: el Auto Scaling Group las va a registrar solo.

**Protocol version HTTP1, no HTTP2.** Con HTTP2 el balanceador hablaría h2c contra el 8080, y el
Tomcat embebido de Spring Boot no lo tiene habilitado: el health check nunca pasaría y el target
quedaría unhealthy para siempre. **No se puede editar después** — hay que borrar el target group y
crear otro.

**El health check apunta a `/actuator/health/readiness` a propósito, que no toca la base.** Apuntarlo
a `/actuator/health` saca instancias sanas de rotación cuando el pool está ocupado, y convierte un
hipo de RDS en una caída de todo el grupo.

**EC2 → Load Balancers → Create → Application Load Balancer.**

| Ajuste | Valor |
|---|---|
| Nombre | `queue-alb` |
| Scheme | **Internet-facing** |
| IP address type | IPv4 |
| VPC | `q-vpc` |
| Mappings | **`q-public-a` y `q-public-b`** |
| Security group | **`alb-sg` únicamente** — sacá el `default` si aparece |
| Listener | HTTP **80** → forward a `queue-tg` |

**Por qué el ALB va en subredes públicas si la API es privada.** Las subredes que elegís son dónde
viven las interfaces de red *del propio balanceador*, las direcciones a las que se conecta la gente
desde internet. El otro lado no se configura: el ALB alcanza a sus targets por IP privada, ruteando
dentro de la VPC. Por eso lo único que vive en una subred pública es el balanceador, y la API nunca
tiene dirección pública.

Necesita **dos zonas** aunque después tengas una sola instancia. Es un requisito del servicio.

**Anotá el DNS**, algo como `queue-alb-1248792755.us-east-1.elb.amazonaws.com`. Lo necesitás en el
paso 6.

## 5. Los dos buckets

Son dos, y son distintos. **No los mezcles**: uno guarda credenciales, el otro existe para ser
público.

### 5.1 Bucket de artefactos — privado

**S3 → Create bucket** → `queue-s3-625746291868-us-east-1-an`.

Dejá **Block all public access activado** (viene así) y la encriptación por defecto. Nada más.

### 5.2 Bucket del sitio — público

**S3 → Create bucket** → `queue-web-625746291868-us-east-1-an`.

En **Block Public Access**, destildá **"Bloquear todo el acceso público"** para habilitar las cuatro
de abajo, y después **volvé a tildar solo las dos de ACL**:

| | Casilla |
|---|---|
| ✅ | ...a través de **nuevas** listas de control de acceso (ACL) |
| ✅ | ...a través de **cualquier** lista de control de acceso (ACL) |
| ☐ | ...a través de políticas de bucket **nuevas** |
| ☐ | ...a través de **cualquier** política de bucket |

Son dos mecanismos distintos de dar acceso público y vas a usar uno solo. Dejando las ACL bloqueadas,
**nadie puede exponer un objeto por accidente**: la única vía es editar la política, que es un cambio
visible y deliberado. Queda muy bien en el informe: no se abrió "el acceso público", se abrió
exactamente el mecanismo que el diseño necesita.

**Propiedades → Alojamiento de sitios web estáticos → Habilitar:**

| Campo | Valor |
|---|---|
| Documento de índice | `index.html` |
| Documento de error | **`404.html`** |
| Reglas de redireccionamiento | vacías |

El texto gris de esos campos es **ayuda, no valores**: hay que escribirlos. Y el documento de error es
`404.html`, no `error.html` — ese archivo no existe en el export de Next.

**Permisos → Política del bucket:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadForWebsite",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::queue-web-625746291868-us-east-1-an/*"
    }
  ]
}
```

**El `/*` final es necesario** y el nombre tiene que coincidir exactamente con el bucket. `GetObject`
actúa sobre los objetos: un ARN sin `/*`, o con el nombre equivocado, no autoriza nada — y el síntoma
es un `403` idéntico al de no haber puesto política.

Destildar el bloqueo solo **permite** que exista una política pública; no concede nada por sí solo.

### Si la consola falla

Esa pantalla es la que rompe. Vas a ver una de estas dos:

* `access-analyzer:ValidatePolicy` al guardar la política — es solo el validador en vivo, que el rol
  `voclabs` no tiene permitido. **No impide guardar**: si abajo dice `Errores: 0`, dale igual.
* `Error desconocido — n is not iterable` al guardar el website hosting — es un error de JavaScript
  de la consola.

La salida es **CloudShell** (el ícono `>_` arriba a la derecha), que tiene el CLI ya autenticado:

```bash
aws s3api put-bucket-website --bucket queue-web-625746291868-us-east-1-an \
  --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"404.html"}}'
```

```bash
cat > web-policy.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Sid":"PublicReadForWebsite","Effect":"Allow",
"Principal":"*","Action":"s3:GetObject",
"Resource":"arn:aws:s3:::queue-web-625746291868-us-east-1-an/*"}]}
EOF
aws s3api put-bucket-policy --bucket queue-web-625746291868-us-east-1-an --policy file://web-policy.json
```

Verificá:

```bash
aws s3api get-bucket-website --bucket queue-web-625746291868-us-east-1-an
```

## 6. Compilar y subir el frontend

Ya tenés el DNS del ALB, así que ahora sí:

```bash
cd ~/ITBA/Cloud/tp-cloud/frontend
NEXT_PUBLIC_API_URL=http://queue-alb-1248792755.us-east-1.elb.amazonaws.com npm run build
```

**`NEXT_PUBLIC_API_URL` es solo el origen, sin ruta.** `src/lib/api.ts` concatena `/api/v1` él mismo,
así que incluirla produce `/api/v1/api/v1` y todas las llamadas dan 404.

Ese valor **queda compilado dentro del bundle**. Un ALB nuevo obliga a recompilar y volver a subir el
sitio: es la razón para no borrar el balanceador entre sesiones del lab.

> No hace falta acordarse de nada para las credenciales de demostración: `frontend/.env.production`
> tiene `NEXT_PUBLIC_SHOW_DEMO_LOGIN=false`, así que `npm run build` las deja **fuera del bundle**, no
> ocultas. Comprobalo con `grep -r demo1234 out/` — no tiene que devolver nada.

Para subirlo, lo más simple es un zip por CloudShell:

```bash
cd out && zip -qr ../web.zip . && cd ..
```

Subís `web.zip` con **Actions → Upload file**, y en CloudShell:

```bash
mkdir -p web && unzip -q -o web.zip -d web && ls web/index.html
aws s3 sync web/ s3://queue-web-625746291868-us-east-1-an/ --delete
```

En la raíz del bucket tienen que quedar **`index.html` y `404.html` sueltos**, más los prefijos
`_next/`, `login/`, `panel/`, `q/`, `register/`, `t/`. Son unos 88 objetos hoy, pero el número cambia
con cada página que se agregue: lo que importa es que `index.html` esté en la raíz y no bajo un
prefijo.

Si lo subís arrastrando desde la consola, arrastrá **el contenido** de `out/`, no la carpeta: si no,
todo queda bajo un prefijo y el sitio da 404.

**Probalo ya**: abrí el endpoint del sitio. Tenés que ver la portada. El login todavía no va a
funcionar, porque no hay backend.

## 7. `app.env` y el jar

Para acá RDS ya terminó. **RDS → tu instancia → Connectivity & security → Endpoint.**

Escribí este archivo **en tu máquina**, como `app.env`:

```
PORT=8080

DB_URL=jdbc:postgresql://queue-database.ccl4ijx841xf.us-east-1.rds.amazonaws.com:5432/queue_db
DB_USER=queue
DB_PASSWORD=<el master password del paso 3>
DB_POOL_MAX=10

JWT_SECRET=<openssl rand -base64 48>

PUBLIC_BASE_URL=http://queue-web-625746291868-us-east-1-an.s3-website-us-east-1.amazonaws.com
CORS_ORIGINS=http://queue-web-625746291868-us-east-1-an.s3-website-us-east-1.amazonaws.com

SSE_TIMEOUT=5m
SSE_HEARTBEAT=20s

NOTIFY_EMAIL_ENABLED=true
NOTIFY_EMAIL_FROM=queue.cloud.itba@gmail.com
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_AUTH=true
MAIL_STARTTLS=true
MAIL_USERNAME=queue.cloud.itba@gmail.com
MAIL_PASSWORD=<app password de 16 caracteres, sin espacios>
```

Seis cosas que conviene acertar en vez de descubrir después:

* **No pongas `SPRING_PROFILES_ACTIVE=dev`.** Ese perfil enciende `q.seed.enabled`, que siembra un
  establecimiento de demostración con cuentas cuyas contraseñas están en el repositorio.
* **`JWT_SECRET` tiene un default de desarrollo.** Dejarlo produce tokens que cualquiera con el
  repositorio puede falsificar. Mínimo 32 bytes, y distinto del que usás en local.
* **`MAIL_PASSWORD` es un App Password de Gmail, no la contraseña de la cuenta.** Google lo muestra
  en grupos de cuatro: **sacale los espacios**, o los mails fallan en silencio.
* **`CORS_ORIGINS` tiene que ser exactamente el origen del sitio**, mismo esquema y host, sin barra
  final. El sitio y la API son orígenes distintos en esta arquitectura.
* **`PUBLIC_BASE_URL` se imprime en carteles.** Los códigos QR se arman con esa URL, así que un valor
  equivocado sobrevive en el mundo físico bastante después de corregirlo.
* **`JWT_TTL` no existe.** `backend/.env.example` la lista, pero nada la lee: el vencimiento está fijo
  en 12h en `application.yml`.

Compilá el jar:

```bash
cd ~/ITBA/Cloud/tp-cloud/backend && mvn clean package
```

Subí los dos objetos al bucket de artefactos, por la consola o por CloudShell. **El jar tiene que
quedar como `queue-api.jar`**: subirlo desde la consola conserva el nombre largo de Maven y el
user-data va a dar 404 en loop.

```bash
aws s3 cp queue-api-0.1.0-SNAPSHOT.jar s3://queue-s3-625746291868-us-east-1-an/queue-api.jar
aws s3 cp app.env s3://queue-s3-625746291868-us-east-1-an/app.env
```

Confirmá que estén los dos:

```bash
aws s3 ls s3://queue-s3-625746291868-us-east-1-an/
```

## 8. Launch template

Primero necesitás el **id de la AMI de Amazon Linux 2023**. Consola → EC2 → *Launch instance* →
en *Application and OS Images* elegí **Amazon Linux 2023 (x86_64)** y copiá el `ami-…` que muestra.
No lances nada; solo querés el id.

**EC2 → Launch Templates → Create launch template.**

| Ajuste | Valor |
|---|---|
| Nombre | `queue-app` |
| AMI | el `ami-…` de Amazon Linux 2023 |
| Instance type | `t3.small` |
| Key pair | ninguno, o el del bastión si querés poder entrar |
| **Subnet** | **no elegir** — la define el Auto Scaling Group |
| Security group | **`api-sg`** |
| Storage | 8 GB gp3, *Delete on termination* |
| **Advanced → IAM instance profile** | **`LabInstanceProfile`** |
| Advanced → Metadata version | **V2 only (token required)** |
| Advanced → User data | el script de abajo |

> **El instance profile es el olvido más difícil de diagnosticar de todo el despliegue.** Sin él, cada
> instancia arranca, falla al bajar los artefactos con `Unable to locate credentials`, y nunca entra
> al target group. Todo parece correcto hasta el momento exacto en que dejás de mirar.

### User data

Cambiá `BUCKET` si le pusiste otro nombre. El resto no se toca: todo lo demás viene de `app.env`.

```bash
#!/bin/bash
set -uxo pipefail
exec > >(tee /var/log/q-bootstrap.log|logger -t q-bootstrap -s 2>/dev/console) 2>&1

BUCKET=queue-s3-625746291868-us-east-1-an
REGION=us-east-1

# --- identidad ----------------------------------------------------------------------
# IMDSv2: primero un token. La aplicacion estampa este id en cada respuesta y en cada
# linea de log, que es como "cual instancia contesto?" sigue teniendo respuesta detras
# de un balanceador.
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
IID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)

# --- runtime ------------------------------------------------------------------------
dnf -y update
if ! dnf -y install java-25-amazon-corretto-headless; then
  # Corretto 25 puede no estar todavia en los repositorios: se baja de Amazon.
  curl -Lo /tmp/corretto.tar.gz \
    https://corretto.aws/downloads/latest/amazon-corretto-25-x64-linux-jdk.tar.gz
  mkdir -p /opt/java
  tar -xzf /tmp/corretto.tar.gz -C /opt/java --strip-components=1
  ln -sf /opt/java/bin/java /usr/bin/java
fi

useradd --system --no-create-home --shell /sbin/nologin queue
mkdir -p /opt/queue /etc/queue

# --- artefactos ---------------------------------------------------------------------
# Reintenta en vez de asumir: una instancia puede arrancar antes de que termine una
# subida, y una descarga que llega temprano no deberia ser un arranque fallido. El
# trafico va por el Gateway Endpoint de S3, asi que no toca el NAT.
for attempt in $(seq 1 60); do
  if aws s3 cp "s3://$BUCKET/app.env" /etc/queue/queue.env --region "$REGION" --no-progress \
     && aws s3 cp "s3://$BUCKET/queue-api.jar" /opt/queue/queue-api.jar --region "$REGION" --no-progress; then
    echo "artefactos obtenidos en el intento $attempt"
    break
  fi
  echo "artefactos no disponibles (intento $attempt), esperando"
  sleep 15
done

echo "INSTANCE_ID=$IID" >> /etc/queue/queue.env
chown root:queue /etc/queue/queue.env && chmod 640 /etc/queue/queue.env
chown queue:queue /opt/queue/queue-api.jar && chmod 640 /opt/queue/queue-api.jar

# --- servicio -----------------------------------------------------------------------
cat > /etc/systemd/system/queue.service <<'UNIT'
[Unit]
Description=Queue API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=queue
EnvironmentFile=/etc/queue/queue.env
ExecStart=/usr/bin/java -XX:MaxRAMPercentage=70.0 -jar /opt/queue/queue-api.jar
Restart=always
RestartSec=5
KillSignal=SIGTERM
# Comodo por encima del apagado ordenado de 25s de la aplicacion, para que systemd
# nunca la mate a mitad del drenaje.
TimeoutStopSec=40
SuccessExitStatus=143

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now queue

# --- diagnostico --------------------------------------------------------------------
# Esta instancia no tiene direccion publica y nadie va a entrar por SSH, asi que este
# log es lo unico que queda para saber por que un arranque salio mal. Se sube al bucket
# de artefactos, bajo logs/<id de instancia>.log.
#
# El "|| true" es a proposito: que falle la subida del log no debe voltear el arranque.
aws s3 cp /var/log/q-bootstrap.log "s3://$BUCKET/logs/$IID.log" \
  --region "$REGION" --no-progress || true
```

**Ese último bloque es lo que reemplaza al bastión.** Sin él, una instancia que arranca mal es una
caja negra: subred privada, sin IP pública, y la consola serial suele estar bloqueada en el lab.

**Este script corre en el primer arranque de cada instancia nueva**, que es exactamente lo que hace un
Auto Scaling Group. No hay instancia dorada ni AMI que hornear. El costo son unos dos minutos más de
arranque, porque instala Java cada vez.

## 9. Auto Scaling Group

**EC2 → Auto Scaling Groups → Create.**

| Ajuste | Valor |
|---|---|
| Nombre | `queue-asg` |
| Launch template | `queue-app` |
| VPC | `q-vpc` |
| **Subredes** | **`q-app-a` y `q-app-b`** |
| Load balancing | *Attach to an existing load balancer* → `queue-tg` |
| **Health check type** | **EC2** |
| Health check grace period | **300s** |
| Min / Desired / Max | **2 / 2 / 4** |

**Por qué EC2 y no ELB.** El check del target group llega a la aplicación, y si un fallo condujera al
*reemplazo*, una caída de la base terminaría cada instancia y sus reemplazos fallarían el mismo check:
un bucle infinito a partir de un problema recuperable. Así, un hipo de la base degrada el servicio en
vez de destruir el grupo.

**Por qué mínimo 2.** Una instancia en cada zona, que es lo que hace real el diseño Multi-AZ.

**Por qué máximo 4.** 8 es el techo *de la base* calculado en el paso 3. 4 es una decisión de costo, y
subirlo es cambiar un campo — pero nunca por encima de 8 sin subir también la clase de RDS.

Al terminar, el grupo lanza dos instancias. **Tardan unos 3–4 minutos** en aparecer sanas: instalar
Java y bajar el jar lleva su tiempo.

### Escalado por horario

**Pestaña *Automatic scaling* → *Scheduled actions* → Create**, ocho veces. Todas con time zone
`America/Argentina/Buenos_Aires`, y **fijando solo Min y Desired** — dejá Max vacío, para que las
políticas reactivas conserven siempre el mismo margen.

| Nombre | Cron | Min | Desired | |
|---|---|---|---|---|
| `overnight` | `0 3 * * *` | 1 | 1 | madrugada |
| `morning` | `0 9 * * *` | 2 | 2 | apertura |
| `lunch` | `45 11 * * *` | 2 | 3 | almuerzo |
| `afternoon` | `30 15 * * *` | 2 | 2 | valle de tarde |
| `dinner-weeknight` | `45 19 * * 0-4` | 2 | 3 | cena de domingo a jueves |
| `dinner-weeknight-end` | `30 0 * * 1-5` | 2 | 2 | cierre de esa cena |
| `dinner-weekend` | `45 19 * * 5,6` | 2 | 4 | viernes y sábado |
| `dinner-weekend-end` | `0 2 * * 6,0` | 2 | 2 | cierre de esa cena |

Dos cosas de esa tabla son fáciles de tipear mal:

* **El día 0 del cron es domingo, y los rangos de las cenas no son erratas.** Una acción se nombra por
  el servicio al que pertenece pero se agenda para el momento en que **dispara**, y una cena de jueves
  termina a las 00:30 del viernes. De ahí que el pico de semana corra `0-4` y su bajada `1-5`.
* **La madrugada baja a una instancia y ahí se pierde la redundancia entre zonas.** Es una decisión de
  costo consciente. Si el informe necesita redundancia continua, poné 2 en vez de 1.

### Políticas reactivas

**Pestaña *Automatic scaling* → *Dynamic scaling policies* → Create**, dos veces, ambas de tipo
**Target tracking**:

| Nombre | Métrica | Target | Instance warmup |
|---|---|---|---|
| `request-count` | **Application Load Balancer request count per target** | 500 | 300s |
| `cpu` | **Average CPU utilization** | 60 | 300s |

Al elegir la primera, la consola te va a pedir el target group: elegí `queue-tg`.

El grupo evalúa las dos y aplica **la que pida más capacidad**.

**Por qué el escalado es principalmente por horario.** Un restaurante se llena por reloj, y además el
recurso que realmente limita a la instancia —la memoria— **no es observable desde el grupo**: las
métricas nativas de EC2 las publica el hipervisor, que mide lo que cruza la capa de virtualización y
no puede ver dentro del sistema operativo huésped.

`ALBRequestCountPerTarget` es la única que ve la ocupación, y solo por una decisión tomada en la
aplicación: `SSE_TIMEOUT` es de cinco minutos, así que cada stream abierto expira y el navegador
reconecta solo. Un espectador ocioso se re-anuncia doce veces por hora, lo que convierte el conteo de
requests en un proxy de la cantidad de conexiones — y las conexiones son lo que consume la memoria.
Con unos 2.500 streams por instancia eso cae cerca de 500 requests por target por minuto.

La de CPU es un último recurso genuino, no un socio igual: se midieron **0,72% de CPU con 400
conexiones abiertas**. Está para atrapar una instancia patológica, no carga normal.

Las dos usan métricas **predefinidas** de Auto Scaling, así que ninguna necesita publicar métricas
propias con `PutMetricData`.

Para demostrar la reactiva sin generar carga real: bajá el target de `request-count` a **10**, abrí
varias pestañas, y mirá subir la capacidad en *Activity*. Después restauralo a 500.

## 10. Verificación

Las primeras cuatro prueban que funciona; las dos últimas son las que pide la consigna.

**1. Los targets están sanos.** `queue-tg` muestra **dos** instancias *healthy*. Si no, mirá el paso
*Si algo falla*.

**2. La API responde por el balanceador.**

```bash
curl -s http://queue-alb-1248792755.us-east-1.elb.amazonaws.com/actuator/health/readiness
```

`{"status":"UP"}` significa que el camino completo funciona: internet → ALB → security group →
instancia en subred privada → RDS.

**3. La aplicación anda.** Abrí el endpoint del sitio, registrate, creá una fila, escaneá el QR y
unite desde otro navegador.

**4. Las actualizaciones cruzan instancias.** La única prueba que una sola instancia no puede pasar.
Con el ticket abierto en un dispositivo, llamá al siguiente desde el panel en otro navegador: el
ticket tiene que moverse solo. Compará `X-Instance-Id` en las dos sesiones para mostrar que las
atendieron instancias distintas — eso prueba que el trabajo lo hace el canal `NOTIFY` de PostgreSQL y
no estado en memoria.

```bash
curl -sI http://queue-alb-1248792755.us-east-1.elb.amazonaws.com/api/v1/actuator/health | grep -i x-instance-id
```

Correlo varias veces: el id tiene que alternar.

**5. La base rechaza internet.** Desde tu notebook:

```bash
psql "postgresql://queue@queue-database.ccl4ijx841xf.us-east-1.rds.amazonaws.com:5432/queue_db"
```

Tiene que **colgar y expirar**, no ser rechazado. Un timeout es la demostración más fuerte: significa
que los paquetes nunca llegaron. Dos cosas independientes lo causan, y conviene nombrar las dos — las
subredes de base no tienen ruta fuera de la VPC, y RDS no es accesible públicamente.

**6. A la capa de aplicación tampoco se entra.** Tomá la IP privada de una instancia del grupo
(`10.0.10.x` o `10.0.11.x`) e intentá alcanzarla desde tu notebook:

```bash
ssh -o ConnectTimeout=10 ec2-user@10.0.11.101
curl -m 10 http://10.0.11.101:8080/actuator/health/readiness
```

Los dos tienen que expirar. Son direcciones privadas sin ruta desde internet, y `api-sg` solo acepta
el 8080 desde `alb-sg`. **Lo que sí responde es el mismo endpoint por el balanceador**, que es el
contraste que vale mostrar: la aplicación está viva y es alcanzable únicamente por la puerta prevista.

Si levantaste el bastión, el contraste es más fuerte todavía: desde ahí el `curl` a esa misma
dirección sí contesta.

### Si algo falla

**Empezá por el log del arranque, que no requiere entrar a ninguna instancia.** El user-data lo sube
al bucket de artefactos:

```bash
aws s3 ls s3://queue-s3-625746291868-us-east-1-an/logs/
aws s3 cp s3://queue-s3-625746291868-us-east-1-an/logs/i-0abc....log - | tail -40
```

Ahí se ve exactamente dónde se cortó: si no encontró credenciales, si el objeto no existe, si Java no
instaló. Cubre casi todos los casos.

Si el log llega completo y la aplicación igual no responde, ahí sí hace falta entrar. Levantá el
bastión, agregá la regla SSH a `api-sg` desde `bastion-sg`, y desde la instancia:

```bash
sudo journalctl -u queue -n 60 --no-pager
```

Buscá estas dos líneas, que son las que confirman que arrancó bien:

```
Successfully applied 4 migrations to schema "public", now at version v4
Listening for 'queue_changed' notifications from PostgreSQL
```

**La segunda es la importante.** Si falta, las actualizaciones en vivo funcionan dentro de una
instancia y fallan **en silencio** entre dos, que es justo lo que prueba el punto 4.

Si Flyway aplicó menos migraciones de las que tiene el repositorio, el jar que subiste es viejo.

---

## Desplegar una versión nueva

```bash
cd ~/ITBA/Cloud/tp-cloud/backend && mvn clean package
aws s3 cp target/queue-api-0.1.0-SNAPSHOT.jar s3://queue-s3-625746291868-us-east-1-an/queue-api.jar
```

Después **instance refresh** sobre el grupo (*Auto Scaling Groups → Instance refresh → Start*). Eso es
todo: sin AMI, sin tocar el launch template.

* **Las instancias corriendo no toman el jar nuevo solas.** Lo bajan una vez, al arrancar. Subirlo no
  despliega nada por sí mismo.
* **Para volver atrás**, subí el jar anterior y refrescá de nuevo. Conviene activar versionado en el
  bucket.

Cada instancia corre Flyway al arrancar. Es seguro con varias arrancando a la vez —Flyway toma un
lock— pero significa que **una migración mala falla el arranque de todo el grupo**, reemplazos
incluidos. Probá las migraciones antes de subir.

Para el frontend: recompilar con el DNS del ALB y `aws s3 sync out/ s3://... --delete`.

### Si el arranque de dos minutos molesta

Se puede hornear una AMI después, sin rehacer nada: lanzá una instancia con este launch template,
esperá a que quede sana, **borrá `/etc/queue/queue.env` y `/opt/queue/queue-api.jar`** para no hornear
credenciales, creá la imagen, y apuntá una versión nueva del launch template a esa AMI con un
user-data reducido a solo bajar los artefactos. El arranque baja a unos 40 segundos.

---

## Diferencias con la arquitectura propuesta

`infra/q-stack.yaml` describe la arquitectura pensada: **una distribución de CloudFront con dos
orígenes** — el sitio desde S3 privado con OAC, y `/api/*` hacia el ALB. Resolvía tres problemas a la
vez: sin certificado ni dominio que comprar, sin CORS porque todo era un mismo origen, y sin contenido
mixto.

**El Learner Lab no habilita CloudFront.** El rol `voclabs` no tiene ningún permiso del servicio:

```
User: ...assumed-role/voclabs/... is not authorized to perform: cloudfront:ListFunctions
because no identity-based policy allows the cloudfront:ListFunctions action
```

Y la solución que sugiere la consola —agregarle una política al rol— tampoco es posible: el lab no
permite modificar `voclabs`.

| | Propuesto | Desplegado |
|---|---|---|
| Sitio | S3 privado detrás de CloudFront | S3 público con website hosting |
| HTTPS | Sí | **No** |
| Orígenes | Uno | Dos: el sitio y el ALB |
| CORS | No hacía falta | Configurado en `CORS_ORIGINS` |
| Caché en el borde | Sí | No |
| Rutas públicas | `/q/{id}` y `/t/{token}` | `/q/?id=` y `/t/?token=` |

**El cambio de rutas es consecuencia directa.** Las dos rutas públicas son dinámicas y el id no se
conoce al compilar, así que dependían de una reescritura por CloudFront Function que mapeaba
`/q/loquesea` sobre `/q/index.html`. El hosting estático de S3 no puede expresar eso: resuelve
documentos índice pero no reescribe. Llevar el id a la query string elimina la necesidad de cualquier
regla —`/q/?id=abc` resuelve solo— a costa de URLs menos limpias en un cartel.

No hay problema de contenido mixto porque todo es HTTP plano.

**Para el informe conviene presentarlo así: es una limitación del entorno, no una decisión de
diseño.** La plantilla del repositorio describe la arquitectura completa con CDN, y se documenta que
en el Learner Lab se desplegó la variante sin ella, explicando qué se pierde.

---

## Costos y apagar el lab

**"Stop Lab" solo detiene instancias EC2.** Lo que se factura por hora sigue corriendo, y un ALB ni
siquiera tiene estado "detenido": o existe y factura, o se borra.

| Recurso | Por día (aprox.) | ¿Lo para el Stop Lab? |
|---|---|---|
| NAT Gateway | US$1,08 | **No** |
| RDS Multi-AZ `db.t3.micro` | US$0,82 | **No** |
| ALB | US$0,54 | **No** |
| EC2 detenidas (solo EBS) | US$0,06 | Sí |
| S3 | centavos | — |

Para dejarlo de un día para otro:

* **Borrá el NAT Gateway** y **liberá su Elastic IP** — es lo más caro y nada depende de su identidad.
  Recrearlo son tres pasos y cinco minutos, pero **acordate de volver a poner la ruta** en `q-rt-app`:
  si no, las instancias arrancan igual (los artefactos bajan por el Gateway Endpoint) y lo único que
  falla, en silencio, son los mails.
* **Poné el Auto Scaling Group en 0** (*Edit → Desired/Min = 0*) para que no relance instancias.
* **Detené RDS**, no la borres. Se reactiva sola a los 7 días.
* **Dejá el ALB.** Su DNS está compilado dentro del bundle del frontend, así que uno nuevo obliga a
  recompilar y volver a subir el sitio.

---

## Problemas frecuentes

| Síntoma | Causa |
|---|---|
| Los targets nunca quedan sanos | Protocol version HTTP2 en el target group, o el path del health check |
| Las instancias arrancan y no entran al grupo | **Falta `LabInstanceProfile`** en el launch template |
| `Unable to locate credentials` en `q-bootstrap.log` | Lo mismo |
| El log reintenta 15 minutos y falla | Nombre de objeto equivocado, o falta el Gateway Endpoint en `q-rt-app` |
| La app arranca pero le faltan funciones | Jar viejo — revisá cuántas migraciones aplicó Flyway |
| Las actualizaciones no cruzan navegadores | Falta `Listening for 'queue_changed'` en el log |
| `FATAL: sorry, too many clients already` | `max_instancias × (DB_POOL_MAX + 1)` superó el techo de RDS |
| Los mails no llegan y no hay error | `MAIL_PASSWORD` con espacios, o el NAT borrado sin recrear la ruta |
| `403` en el sitio | Bucket policy: ARN equivocado o sin `/*` |
| `404` en el sitio | Los archivos quedaron bajo un prefijo en vez de la raíz |
| Instancias reemplazadas en bucle | Health check ELB en vez de EC2 |
| El navegador da error de certificado | El sitio es HTTP; no hay HTTPS sin CloudFront |
| `n is not iterable` al guardar en S3 | Bug de la consola — usá CloudShell (paso 5) |
