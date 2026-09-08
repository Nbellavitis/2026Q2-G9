# Deploying Queue by hand

Written for a manual deployment: no Terraform, no CloudFormation, no container registry. Everything
here is done from the AWS console and an SSH session.

`infra/q-stack.yaml` describes the same architecture as a stack. It is the better option once the
shape stops changing; this document is what you follow while it still is, and what you read when you
need to know *why* something is set the way it is.

---

## How the application gets onto an instance

This decision comes first because it shapes almost every step after it.

An Auto Scaling Group launches instances on its own, at 19:45 on a Friday, with nobody watching.
Those instances have to come up already serving. So the manual work is done **once**, on a single
instance, and then frozen into an AMI:

```
build  ->  one instance by hand  ->  verify  ->  bake an AMI  ->  launch template  ->  ASG
```

That is the part that matters, and it is what makes the packaging question smaller than it looks.

### On shipping the Docker image through S3

Yes — S3 is the right place, given the constraints. The natural home for a container image is a
registry, and ECR is not among the services this project is allowed to use, so a bucket is the
sensible substitute. The mechanism is two commands:

```bash
docker build -t queue-api:1.0 backend
docker save queue-api:1.0 | gzip > queue-api.tar.gz
aws s3 cp queue-api.tar.gz s3://<artifacts-bucket>/
```

and on the instance:

```bash
aws s3 cp s3://<artifacts-bucket>/queue-api.tar.gz - | gunzip | docker load
```

That transfer goes over the **S3 Gateway Endpoint**, so it never crosses the NAT Gateway — no
per-GB NAT charge and no dependency on the NAT being healthy.

**But weigh it before choosing it.** Measured: the jar is **65 MB**. The same application as a
JRE-based image is around 200 MB uncompressed, near 100 MB as a gzipped `docker save` tarball, and
every instance additionally has to install and run the Docker daemon. On an EC2 that runs exactly
one process, there is nothing for a container to isolate that process *from* — the isolation you are
paying for is already provided by the instance boundary.

The Dockerfile in `backend/` is genuinely valuable: it makes the build reproducible, it is how the
app runs locally, and it is what the project would ship to any other platform. It is just not
obviously an improvement on this particular deployment target.

### The three options, honestly

| | How it works | Boot time | Use it when |
|---|---|---|---|
| Jar baked into the AMI | jar and systemd unit are already in the image | Fastest — nothing is downloaded | The version changes rarely |
| **Jar pulled from S3 at boot** | a fetch unit polls the bucket, then systemd starts the app | ~1 min, and boot fails if the object is missing | **This deployment.** A new version is an upload, not a rebake |
| Docker image via S3 | `docker save` / `docker load` as above | Slowest — daemon install plus ~100 MB | You want one artifact that runs identically everywhere |

Note that once you bake the AMI, the jar-versus-Docker question largely dissolves: nothing is
downloaded at boot either way, and Docker becomes merely how the application is packaged *inside*
the image. If you want to use the container, bake an AMI that already has Docker installed and the
image already loaded, and have systemd run `docker run` instead of `java -jar`.

**This document takes the second option: the jar lives in S3 and the instance fetches it at boot.**
The AMI holds the runtime and the systemd units; it does not hold the application or its secrets.
That buys three things worth having:

* **A new version is an upload plus an instance refresh** — no rebaking, no launch template edit.
* **No credentials in the image.** `queue.env` is fetched from a private bucket at boot rather than
  frozen into a snapshot that is easy to share by accident.
* **Step 10 stops being a rebake.** `PUBLIC_BASE_URL` and `CORS_ORIGINS` only exist once CloudFront
  does, and with this approach that is a re-upload and a restart rather than a second AMI.

And one thing worth knowing before you rely on it: **a missing or corrupt object in the bucket fails
every instance the group launches, including the replacements it launches to recover.** Baking is
more brittle to change; fetching is more brittle to a bad upload. The fetch unit below polls rather
than failing immediately, which covers the ordinary case of an instance booting before the upload
finished — but it cannot save you from publishing a jar that does not start.

---

## Order of operations

Each step needs the one before it, so this order avoids going back:

1. **Network** — VPC, six subnets, Internet Gateway, NAT, route tables, S3 Gateway Endpoint
2. **Security groups** — `sg-alb`, `sg-app`, `sg-rds`, chained
3. **RDS** — PostgreSQL, Multi-AZ, isolated subnets, not publicly accessible
4. **Build and publish the artifacts** — the artifacts bucket, the jar, `app.env`
5. **The golden instance** — one EC2, configured by hand
6. **Bake the AMI**
7. **Target group and load balancer**
8. **Launch template and Auto Scaling Group**
9. **Frontend** — S3 and CloudFront
10. **Re-publish** — `PUBLIC_BASE_URL` and `CORS_ORIGINS` only exist once CloudFront does

Step 10 is not a mistake in the plan; it is a consequence of the application needing to know its own
public address, which does not exist until step 9. Because the configuration is fetched from S3
rather than baked in, that step is a re-upload rather than a second AMI.

---

## 1. Network

| Tier | Subnets | Route to `0.0.0.0/0` |
|---|---|---|
| Public | `public-a`, `public-b` | Internet Gateway |
| Application | `app-a`, `app-b` | NAT Gateway |
| Database | `db-a`, `db-b` | **none at all** |

The database tier having no default route is not a formality — it is half of the isolation
demonstration in step 11. Do not add one "just in case".

Add a **Gateway Endpoint for S3**, associated with the application route table. Without it, every
artifact download and every log upload from a private instance goes out through the NAT and is
billed per GB.

**One NAT Gateway or two?** One is enough here and costs half as much. Two removes a single point of
failure for outbound traffic — but outbound traffic from the app tier is only used for package
installs and SMTP, so a NAT outage degrades email rather than taking the product down. One, and say
so deliberately in the report.

## 2. Security groups

Chain them **by group id, never by CIDR**. That is what makes the isolation demonstrable rather than
merely claimed.

| Group | Port | Inbound from |
|---|---|---|
| `sg-alb` | 80, 443 | `0.0.0.0/0` |
| `sg-app` | 8080 | **`sg-alb`** |
| `sg-rds` | 5432 | **`sg-app`** |

Leave outbound as the default allow-all. The application needs S3, the package repositories and
Gmail's SMTP; enumerating those by address is churn without a security gain, since the tier already
cannot be reached from outside.

## 3. RDS

| Setting | Value | Why |
|---|---|---|
| Engine | PostgreSQL 16 | `LISTEN/NOTIFY` is what carries live updates between instances |
| Class | `db.t3.micro` | Enough here; note the connection ceiling below |
| Multi-AZ | **Yes** | The failover half of the design |
| Storage | 20 GB gp3 | gp3 gives baseline IOPS that do not depend on volume size |
| Subnet group | `db-a`, `db-b` | |
| Publicly accessible | **No** | |
| Security group | `sg-rds` | |
| Initial database | `qdb` | |

**The connection ceiling is a real constraint, not a footnote.** PostgreSQL on RDS computes
`max_connections` from instance memory — roughly 110 on a `db.t3.micro`. Each application instance
holds `DB_POOL_MAX` pooled connections **plus one long-lived `LISTEN` session**, which is easy to
forget:

```
max_instances x (DB_POOL_MAX + 1)  <=  80% of max_connections
```

With a pool of 10 that puts the safe ceiling at 8 instances. Raising the group's maximum without
raising the database class will exhaust it.

## 4. Build and publish the artifacts

```bash
cd backend && mvn clean package
```

```bash
cd frontend && NEXT_PUBLIC_API_URL=https://<cloudfront-domain> npm run build
```

`NEXT_PUBLIC_API_URL` is the **origin only** — no path. `src/lib/api.ts` appends `/api/v1` itself, so
including it here produces `/api/v1/api/v1` and every call 404s.

`backend/target/queue-api-0.1.0-SNAPSHOT.jar` and `frontend/out/` are everything that gets deployed.
The frontend build needs the CloudFront domain, so on the first pass either build it after step 9 or
rebuild it then.

### The artifacts bucket

Create a **private** bucket — `q-artifacts-<account>-<region>` — with Block Public Access fully on
and default encryption enabled. It holds two objects, and one of them is secret:

| Object | What it is |
|---|---|
| `queue-api.jar` | The application |
| `app.env` | The contents of `queue.env` from step 5, including the database password, the JWT secret and the Gmail App Password |

This is a different bucket from the one serving the frontend. Do not reuse that one: it is read by
CloudFront and exists to be public.

```bash
aws s3 cp backend/target/queue-api-0.1.0-SNAPSHOT.jar s3://q-artifacts-<account>-<region>/queue-api.jar
aws s3 cp app.env s3://q-artifacts-<account>-<region>/app.env
```

Two things have to be true for an instance in a private subnet to read this:

* **The S3 Gateway Endpoint from step 1 must be associated with the application route table.** Without
  it the download still works, but it goes out through the NAT Gateway and is billed per GB.
* **The instance needs an instance profile granting S3 read.** In the AWS Academy Learner Lab, attach
  the provided `LabInstanceProfile` — that environment does not allow creating roles. Outside it, a
  role with read access to this bucket only.

There is no credential on the instance for this: the instance profile is what authenticates the
`aws s3 cp`, which is the reason the secrets can live in a bucket instead of in the image.

## 5. The golden instance

Launch one EC2 — Amazon Linux 2023, `t3.small` — into `app-a` with `sg-app`. It needs the NAT to
reach the package repositories. Reach it through a bastion in a public subnet.

```bash
sudo dnf install -y java-25-amazon-corretto-headless
```

> If that package is not in the repositories yet, take the Corretto 25 tarball from
> <https://docs.aws.amazon.com/corretto/> and unpack it into `/opt/java`. The application needs
> Java 25.

```bash
sudo useradd --system --no-create-home --shell /sbin/nologin queue
sudo mkdir -p /opt/queue /etc/queue
sudo chown queue:queue /opt/queue
```

**Do not copy the jar up with `scp`.** It comes from the bucket, and it has to come from the bucket
on every instance the group ever launches — including the ones that launch at 19:45 on a Friday with
nobody watching. What you are building here is the machine that knows how to fetch it.

Confirm the instance can actually reach the bucket before going further, because this is the step
that fails silently otherwise:

```bash
aws s3 ls s3://q-artifacts-<account>-<region>/
```

An `Unable to locate credentials` means no instance profile is attached. A hang means the S3 Gateway
Endpoint is missing and there is no NAT route either.

### Configuration

Everything the application needs comes from `/etc/queue/queue.env`. The application reads that path
itself — `spring.config.import` in `application.yml` lists it — so the values are picked up whether
or not systemd also passes them in. It is the same file as the `.env` used locally, with production
values. `backend/.env.example` is the annotated template and is close to authoritative on variable
names — with one exception: it lists `JWT_TTL`, which nothing reads. The token lifetime is fixed at
12h in `application.yml`, so setting that variable has no effect.

**Write this file on your own machine as `app.env` and upload it to the artifacts bucket** (step 4).
Do not hand-write it on the golden instance: it would be baked into the AMI, and then every instance
in the group would carry a snapshot of your credentials that no longer matches the bucket.

```
PORT=8080

DB_URL=jdbc:postgresql://<rds-endpoint>:5432/qdb
DB_USER=<user>
DB_PASSWORD=<password>
DB_POOL_MAX=10

JWT_SECRET=<openssl rand -base64 48>

PUBLIC_BASE_URL=https://<cloudfront-domain>
CORS_ORIGINS=https://<cloudfront-domain>

SSE_TIMEOUT=5m
SSE_HEARTBEAT=20s

NOTIFY_EMAIL_ENABLED=true
NOTIFY_EMAIL_FROM=<your gmail address>
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_AUTH=true
MAIL_STARTTLS=true
MAIL_USERNAME=<your gmail address>
MAIL_PASSWORD=<16-character app password>
```

The fetch unit below is what puts this file on the instance and sets its permissions, so there is
nothing to `chmod` by hand.

Four things worth getting right rather than discovering later:

* **Do not set `SPRING_PROFILES_ACTIVE=dev`.** The `dev` profile seeds a demo establishment with
  accounts whose passwords are in the README.
* **`JWT_SECRET` has a development default.** Leaving it produces tokens anyone holding this
  repository can forge. Minimum 32 bytes.
* **`PUBLIC_BASE_URL` is printed onto posters.** QR codes and ticket links are built from it, so a
  wrong value survives in the physical world long after you fix it.
* **`MAIL_PASSWORD` is a Gmail App Password, not the account password.** It needs 2FA enabled on the
  account, and it is 16 characters with no spaces.

### Fetching the artifacts at boot

`/usr/local/bin/queue-fetch`, `chmod 755`:

```bash
#!/bin/bash
set -euo pipefail

BUCKET=q-artifacts-<account>-<region>
REGION=<region>

# Poll rather than assume. An instance can boot before the upload has finished - during the first
# build, or when the group replaces an instance while you are mid-deploy - and a download that is
# merely early should not become a failed boot.
for attempt in $(seq 1 60); do
  if aws s3 cp "s3://$BUCKET/app.env" /etc/queue/queue.env --region "$REGION"      && aws s3 cp "s3://$BUCKET/queue-api.jar" /opt/queue/queue-api.jar --region "$REGION"; then
    chown root:queue /etc/queue/queue.env && chmod 640 /etc/queue/queue.env
    chown queue:queue /opt/queue/queue-api.jar && chmod 640 /opt/queue/queue-api.jar
    echo "artifacts retrieved on attempt $attempt"
    exit 0
  fi
  echo "artifacts not ready (attempt $attempt), waiting"
  sleep 15
done

echo "giving up after fifteen minutes" >&2
exit 1
```

`/etc/systemd/system/queue-fetch.service`:

```
[Unit]
Description=Fetch Queue artifacts from S3
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/queue-fetch

[Install]
WantedBy=multi-user.target
```

### The service

`/etc/systemd/system/queue.service`:

```
[Unit]
Description=Queue API
After=network-online.target queue-fetch.service
Wants=network-online.target
# Requires, not Wants: without the jar and the environment file there is nothing to start, and a
# failed fetch should surface as a failed unit rather than as a Java stack trace.
Requires=queue-fetch.service

[Service]
Type=simple
User=queue
EnvironmentFile=/etc/queue/queue.env
ExecStart=/usr/bin/java -XX:MaxRAMPercentage=70.0 -jar /opt/queue/queue-api.jar
Restart=always
RestartSec=5
KillSignal=SIGTERM
# Comfortably above the application's own 25 second graceful shutdown budget, so
# systemd never kills it mid-drain.
TimeoutStopSec=40
SuccessExitStatus=143

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now queue-fetch queue
```

`enable` on **both** is the part that matters for the AMI: it is what makes an instance the group
launches fetch its artifacts and come up serving without anyone logging in. Forgetting it on
`queue-fetch` produces the worst version of this failure — the golden instance works, because you
ran the fetch by hand, and every instance the group launches afterwards does not.

```bash
curl -s localhost:8080/actuator/health/readiness && sudo journalctl -u queue -n 40 --no-pager
```

Two lines in the log are the ones worth looking for:

```
Instance identity: <id>
Listening for 'queue_changed' notifications from PostgreSQL
```

The second is what confirms the cross-instance channel is alive. If it is missing, live updates will
still work within one instance and fail silently across two — which is exactly the case the
demonstration in step 11 tests.

`INSTANCE_ID` does not need to be in `queue.env`: the application falls back to the hostname, and on
EC2 that is already distinct per instance (`ip-10-0-2-15`). Set it from instance metadata only if you
want the real instance id in the header.

## 6. Bake the AMI

**Actions → Image and templates → Create image.** Leave the instance running; the snapshot is
consistent enough for a stateless application.

Be clear about what this image does and does not contain:

| In the image | Not in the image |
|---|---|
| Java 25 | The jar |
| The `queue-fetch` script and both systemd units | `queue.env`, and therefore every credential |
| The bucket name and region, hard-coded in the script | The RDS endpoint, which lives in `queue.env` |

That split is the point. Changing the application, the database endpoint or any secret is an upload
to the bucket; only changing the *runtime* — a new Java version, a change to the units — needs a new
AMI.

The bucket name and region are the one deployment detail frozen into the snapshot. Moving to a
different bucket means rebaking, so pick the name before this step.

## 7. Target group and load balancer

Target group, HTTP, port 8080. The health check is the setting that matters most:

| | |
|---|---|
| Path | **`/actuator/health/readiness`** |
| Healthy / unhealthy threshold | 2 / 3 |
| Timeout / interval | 5s / 15s |
| **Deregistration delay** | **120s** |

`/actuator/health/readiness` deliberately does **not** check the database. Pointing this at
`/actuator/health` instead takes healthy instances out of service whenever the connection pool is
busy — and worse, turns a database blip into a group-wide outage.

The deregistration delay matters because SSE connections are long-lived: scaling in cuts them, and
120s is long enough for requests in flight without making every scale-in wait.

Then an internet-facing ALB across `public-a` and `public-b`, with `sg-alb`, forwarding to the group.

## 8. Launch template and Auto Scaling Group

Launch template: the AMI just baked, `t3.small`, `sg-app`, **no user data** — systemd already handles
startup.

**Set the IAM instance profile on the launch template** (`LabInstanceProfile` in the Learner Lab).
This is the single easiest thing to miss and the most confusing to diagnose: the golden instance had
a profile attached directly, so it fetched fine and baked fine, but an AMI does not carry one. Every
instance the group launches would come up, fail `queue-fetch` with a credentials error, and never
join the target group.

| | |
|---|---|
| Subnets | `app-a`, `app-b` |
| Min / desired / max | **2 / 2 / 4** |
| Health check type | **EC2** |
| Health check grace period | **300s** |

**Why `t3.small` and not a memory-optimised instance.** Memory is what limits this workload — each
open SSE stream costs about 95 KB and essentially no processor time. A memory-optimised instance is
cheaper per GB, but a single one would hold the entire projected peak, leaving the group with nothing
to scale. The burstable family fits a low, steady CPU profile, and capacity is added by launching
instances rather than enlarging them.

**Why EC2 health checks and not ELB.** The target group's check reaches the application, and if a
failing check drove *replacement*, a database outage would terminate every instance and their
replacements would fail the same check — an endless replacement loop out of a recoverable problem.
This way a database blip degrades the service instead of destroying the group.

**Why min 2.** One instance in each Availability Zone, which is what makes the Multi-AZ design real
rather than drawn.

**Why max 4 and not 8.** 8 is the *database* ceiling computed in step 3. 4 is a cost choice, and
raising it is a one-field change — but never above 8 without also raising the database class.

### Scheduled scaling

Add these under **Automatic scaling → Scheduled actions**, all in `America/Argentina/Buenos_Aires`.
Set min and desired; leave max alone so the reactive policies below always keep the same headroom.

| Cron | Days | Min | Desired | |
|---|---|---|---|---|
| `0 3 * * *` | every day | 1 | 1 | overnight |
| `0 9 * * *` | every day | 2 | 2 | opening |
| `45 11 * * *` | every day | 2 | 3 | lunch |
| `30 15 * * *` | every day | 2 | 2 | afternoon |
| `45 19 * * 0-4` | Sun–Thu | 2 | 3 | dinner |
| `30 0 * * 1-5` | Mon–Fri | 2 | 2 | that dinner ending |
| `45 19 * * 5,6` | Fri–Sat | 2 | 4 | the week's largest peak |
| `0 2 * * 6,0` | Sat–Sun | 2 | 2 | that dinner ending |

Two things about that table are easy to get wrong:

* **Day 0 is Sunday**, and the ranges are not typos. An action is named for the service it belongs to
  but scheduled for the moment it *fires* — a Thursday dinner ends at 00:30 on Friday. Hence the
  weeknight peak on `0-4` and its scale-in on `1-5`.
* **Overnight drops to one instance**, giving up AZ redundancy for six hours. That is a deliberate
  cost trade; if the report needs redundancy stated as continuous, use 2 instead of 1.

### Reactive policies

Scheduled scaling is primary because a restaurant fills up by the clock, and because the resource
that actually limits an instance — memory — is not measurable from the group at all. EC2's native
metrics are published by the hypervisor, which meters what crosses the virtualisation boundary and
cannot see inside the guest operating system.

Add two target-tracking policies as a safety net for what the calendar does not predict. The group
applies whichever asks for more capacity.

| Policy | Metric | Target |
|---|---|---|
| Request count | `ALBRequestCountPerTarget` | 500 |
| CPU | `ASGAverageCPUUtilization` | 60 |

`ALBRequestCountPerTarget` is the one that can see occupancy, and only because of a decision made in
the application: `SSE_TIMEOUT` is five minutes, so every open stream expires and the browser
reconnects on its own. An idle watcher re-announces itself twelve times an hour, which makes request
count a proxy for connection count — and connection count is what consumes the memory. At roughly
2,500 streams per instance that lands near 500 requests per target per minute.

The CPU policy is a genuine last resort, not an equal partner: 400 open connections measured 0.72%
CPU, so it should never be the policy that decides. It is there to catch a pathological instance — a
runaway loop, a garbage-collection spiral — rather than ordinary load.

Both are **predefined** Auto Scaling metrics, so neither needs a custom metric published with
`PutMetricData`.

To demonstrate the reactive policy without generating real load, temporarily set the request-count
target to about 10, open a handful of tabs on `/q/<queueId>`, and watch the desired capacity climb in
**Auto Scaling Groups → Activity**. Put it back to 500 afterwards.

## 9. Frontend

Upload `frontend/out/` to a private bucket and put CloudFront in front of it, reading the bucket
through an Origin Access Control.

Add `/api/*` as a **second origin** pointing at the load balancer. One distribution with two origins
is what makes the whole product a single HTTPS origin, which removes three problems at once: no
certificate or domain to buy, no CORS between app and API, and no mixed content when an HTTPS page
calls its backend.

The static export needs two rewrites: `/q/*` and `/t/*` each serve their own `index.html`, because
the id in the URL cannot be known at build time. Without them S3 returns `NoSuchKey`.

Cache policy: **disabled** for the `/api/*` behaviour. Caching an API response here would serve one
customer's ticket to another.

## 10. Re-publish with the real URLs

`PUBLIC_BASE_URL` and `CORS_ORIGINS` now have real values. This is where fetching from S3 pays for
itself — there is no second AMI:

```bash
aws s3 cp app.env s3://q-artifacts-<account>-<region>/app.env
```

Then run an **instance refresh** on the group. Each replacement fetches the updated file at boot.

Rebuild and re-upload the frontend too, now that `NEXT_PUBLIC_API_URL` is known.

---

## 11. Verifying the deployment

Run all six. The first four prove it works; the last two are what the assignment asks you to
demonstrate.

**1. Both instances are serving.** The target group shows two healthy targets.

**2. The application answers.** Open the CloudFront URL, sign in, create a queue.

**3. A customer can join.** Scan the QR, join, land on the ticket page.

**4. Live updates cross instances.** The one worth rehearsing, because it is the only test a single
instance cannot pass. Join a queue and keep the ticket page open on a phone; call the next customer
from the staff panel in a different browser. The ticket must move on its own. Check `X-Instance-Id`
on both sessions to show they were served by different instances — that is what proves the
PostgreSQL `NOTIFY` channel is doing the work rather than in-process state.

**5. The database rejects the internet.** From your own laptop:

```bash
psql "postgresql://<user>@<rds-endpoint>:5432/qdb"
```

It must **hang and time out**, not be refused. A timeout is the stronger demonstration: it means the
packets never arrived. Two independent things cause it, and both are worth naming — the database
subnets have no route off the VPC at all, and RDS is not publicly accessible.

**6. The application subnet has no way in either.** SSH straight to an app instance's private
address from outside must fail; only the bastion can reach it.

---

## Deploying a new version

```bash
cd backend && mvn clean package
```

```bash
aws s3 cp backend/target/queue-api-0.1.0-SNAPSHOT.jar s3://q-artifacts-<account>-<region>/queue-api.jar
```

Then **instance refresh** on the group. That is the whole procedure: no AMI, no launch template edit.
Each new instance fetches the new jar at boot, and the refresh replaces the old ones a fraction at a
time so the service stays up.

Two things to know about this:

* **Running instances do not pick up a new jar on their own.** They fetch once, at boot. Until the
  refresh replaces them they keep serving the old version, which is what you want — but it means
  uploading alone deploys nothing.
* **Roll back by re-uploading the previous jar and refreshing again.** Keep the last known-good one;
  enabling versioning on the bucket is the cheap way to make that automatic.

Every instance runs Flyway at startup. That is safe with several starting at once — Flyway takes a
lock and the rest find the migrations already applied — but it does mean a bad migration fails the
whole group's boot, and with the jar coming from S3 it fails the *replacements* too. Test migrations
before uploading.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Targets never healthy | Check the health check path is `/actuator/health/readiness`; then `journalctl -u queue` on the golden instance |
| `502` from CloudFront | The application is not up yet, or the target group has no healthy targets |
| `404` on `/q/<id>` | The CloudFront rewrites for `/q/*` and `/t/*` are missing |
| Live updates work on one browser but not across two | The `NOTIFY` channel is not connected — look for `Listening for 'queue_changed'` in the log |
| `FATAL: sorry, too many clients already` | `max_instances x (DB_POOL_MAX + 1)` exceeded the database ceiling; see step 3 |
| Emails silently never arrive | `MAIL_PASSWORD` is the account password rather than a 16-character App Password |
| Instances replaced in a loop | Health check type is ELB rather than EC2; see step 8 |
| Golden instance works, new instances never start | `queue-fetch` was not `systemctl enable`d, so only the manual run ever happened |
| `queue-fetch` fails with `Unable to locate credentials` | No instance profile on the launch template — the AMI does not carry one |
| `queue-fetch` retries for fifteen minutes then fails | Wrong bucket or key name, or the S3 Gateway Endpoint is not on the application route table |
| New version uploaded but nothing changed | Instances fetch at boot only; run an instance refresh |
