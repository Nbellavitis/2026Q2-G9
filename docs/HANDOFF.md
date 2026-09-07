# Q — session handoff

Everything a new session or a teammate needs to continue without re-deriving it. Written
2026-09-07, at commit `8596d6a`.

> Read [gotchas.md](gotchas.md) before deploying or deleting anything on AWS. This document is the
> map; that one is the minefield.

---

## 1. What this is

**Q (Queue)** — a cloud queue-management platform. A customer scans a QR code, joins a line with
minimal data, and follows their turn from their own phone instead of standing in it. Staff run the
line from a panel.

**ITBA 82.08 Cloud Computing — Trabajo Práctico, Grupo 9.** Nicolás Koron · José María Benegas Lynch ·
Agustín Galán · Nicolás Bellavitis Alzate.

**Repository:** `github.com/josebl123/tp-cloud`, branch `main`. **It is public** — never commit a
secret.

### The deliverables

| Entrega | What it asks | State |
|---|---|---|
| **1 — Propuesta** | Pick and justify an idea | Done. Idea 1, "Queue", from `TP1-Informe-G9.pdf` |
| **2 — Diseño y Demo de Arquitectura Fundacional** | A design document (PDF) **and** a live demo in the lab | Code and infrastructure done; **the PDF is not written** |

Entrega 2's document must contain, by name: portada; evolution of the project since Entrega 1; an
architecture diagram using official AWS icons; a service catalogue table justifying each service
("¿por qué este servicio y no otro?"); and design justification covering **networking** (VPC, subnet
count, public vs private, route tables, gateways/endpoints), **compute and storage** (why EC2, EBS vs
EFS, what S3 is for), **the database** (relational vs non-relational, argued from the data), and
**access control** (security groups, and NACLs if used).

The demo must show the app working and prove the isolation design — the canonical test being that the
database in the private subnet is unreachable from the internet.

### MVP scope

The proposal's five *funcionalidades*, all implemented: QR access and joining; live wait tracking;
turn notifications; queue management by staff; leaving and the grace period. Plus Spanish/English
throughout, and queue lanes (added later by Nicolás Koron — see §6).

---

## 2. Where things stand

| Piece | State |
|---|---|
| Backend API | Complete. **113 tests passing** |
| Frontend SPA | Complete. **No automated tests** — verified by hand |
| i18n (en/es) | Complete, UI and notification emails |
| Realtime (SSE + LISTEN/NOTIFY) | Complete, verified across two instances |
| CloudFormation | Written and validated. **Never actually deployed** |
| Architecture diagram | `infra/q-architecture.drawio`, render-checked |
| Documentation | `docs/` — see §9 |
| **Entrega 2 PDF** | **Not started** |

Nothing here has run on real AWS. The template validates structurally; the first `create-stack` will
likely surface something. See §8.

---

## 3. The stack

**Backend** — Java 25 (LTS) · Spring Boot 3.5.16 · Maven · PostgreSQL 16 · Flyway · Spring Security
with HS256 JWT via Nimbus · springdoc/OpenAPI · ZXing for QR · JUnit 5, Mockito, Testcontainers.

Spring Boot 3.5 rather than 4.x deliberately: both support Java 25, and 3.5 is the mature line.

**Frontend** — Next.js 16.3.3 (App Router, **static export**) · React 19.2.8 · TypeScript 5.9.3 ·
Tailwind CSS 4.3.3. No component library, no data-fetching library, no i18n library — the API client,
the live-resource hook, the design system and the message bundles are all first-party and small.

**Infrastructure** — CloudFormation. VPC across two AZs, ALB, Auto Scaling Group on EC2, RDS
PostgreSQL Multi-AZ, two S3 buckets, one CloudFront distribution with two origins.

---

## 4. Repository map

```
backend/           Spring Boot API
  Dockerfile         multi-stage; JRE runtime, non-root, layered jar
  .env.example       copy to .env — properties syntax, gitignored
  src/main/java/ar/edu/itba/cloud/queue/
    persistence/     entities + Spring Data repositories (only layer that knows the database)
    service/         every business rule; the only layer that touches entities
      command/         inputs to the service layer
      model/           read models returned by it
      notification/    NotificationSender seam + dispatcher
    controller/      HTTP only; request DTOs; never imports an entity
    realtime/        SseHub, RealtimeBus, BroadcastCoordinator, Postgres listener, SseMetrics
    security/        JWT issuing, @CurrentUser, RFC 7807 problem handlers
    config/          AppProperties, SecurityConfig, RealtimeConfig, InstanceIdentity
  src/main/resources/
    db/migration/    V1__init, V2__entry_locale, V3__queue_lanes
    i18n/            notifications.properties (+ _es)
frontend/          Next.js SPA, exported to out/
  src/app/           routes; src/components/ design system; src/lib/ api, auth, i18n, hooks
infra/             q-stack.yaml, q-architecture.drawio, README.md (runbook)
docs/              architecture, domain-model, api-reference, frontend, gotchas, HANDOFF
.agents/plans/     hybrid-lane-eta/PLAN.md — a teammate's working plan
docker-compose.yml PostgreSQL (host port 55432) + Mailpit
```

**Layering is strict and enforced by convention:** JPA entities never leave the service layer;
the service layer never sees an HTTP type. Requests become `service.command` records; responses are
the immutable read models in `service.model`, reused directly as JSON rather than mapped twice.

---

## 5. How to run everything

### Local development

```bash
docker compose up -d
cd backend && mvn spring-boot:run -Dspring-boot.run.profiles=dev
cd frontend && npm run dev
```

App <http://localhost:3000> · API <http://localhost:8080> · Swagger `/swagger-ui.html` ·
Mailpit <http://localhost:8025>. Sign in `owner@demo.q` / `demo1234` (staff: `staff@demo.q`).

**PostgreSQL is on 55432, not 5432** — this machine has its own PostgreSQL on 5432 which silently
answers instead, producing a confusing `role "q" does not exist`.

The `dev` seeder is idempotent; for fresh demo data, truncate first:

```bash
docker exec q-postgres psql -U q -d qdb -c "TRUNCATE TABLE notification_record, queue_event, queue_entry, queue_lane, service_queue, membership, establishment, user_account RESTART IDENTITY CASCADE;"
```

### Tests

```bash
cd backend && mvn test          # 113 tests; Docker must be running
```

Integration tests use Testcontainers against a real PostgreSQL — the pessimistic locks, CHECK
constraints and Flyway migrations are exactly what an in-memory database would fake. If Docker
Desktop has quit you get ~57 context-load errors that look like a code break; `open -a Docker`.

### Container

```bash
cd backend && docker build -t queue-api:1 .
```

Tests are skipped inside the build (Testcontainers needs a daemon the build lacks).

### Frontend for deployment

```bash
cd frontend && NEXT_PUBLIC_API_URL= npm run build
```

**The empty value is required.** It makes API calls relative, so they hit the same CloudFront origin
that served the page — which is what removes CORS and mixed content. Verify with
`grep -r localhost:8080 frontend/out/` finding nothing.

---

## 6. The architecture, in brief

Full reasoning in [architecture.md](architecture.md); this is the shape.

### Data and correctness

- **Positions are never stored.** An entry carries a sparse `order_key` (gap 1000); position is its
  index in the `WAITING` list. A stored position could disagree with the line; a derived one cannot.
- **One pessimistic lock per queue row** (`SELECT … FOR UPDATE`) serialises every mutation. That
  single lock is what stops two staff calling the same person and two joins taking the same ticket
  number.
- **Reads ask before they lock** (added later): public reads check whether anything is due to expire
  over an index, and take the lock only if so.
- **Grace expiry runs lazily on read *and* on a background sweep** — so state is never stale on read,
  and a queue nobody is watching still moves.
- **Four no-show policies**: keep position, move back N, move to end, remove. `gracePeriodSeconds = 0`
  means the clock never decides.

### Lanes (added by Nicolás Koron)

One queue, one QR, but segmented into party-size bands with their own priority, capacity mode
(`PERSONS`/`GROUPS`), `timeFactor` and active flag. `QueueEntrySelector` chooses the next group under
one of three strategies — `GLOBAL_AGE`, `LANE_PRIORITY`, `ROUND_ROBIN` — and **both the real call and
the ETA simulation go through it**, so the quoted wait comes from the rules that will actually serve
you. The round robin rotates over *all* active lanes, because the cursor is a persisted index and
rotating only over occupied lanes starves the lane it exists to protect. `DELETE /queues/{id}`
archives rather than destroys.

### Realtime

SSE, not WebSocket: traffic is unidirectional, it is plain HTTP, and it reconnects itself. Two
streams, both keyed by queue — the staff board and each customer's ticket.

**Across instances**, changes travel through **PostgreSQL LISTEN/NOTIFY**. Each instance holds one
dedicated connection issuing `LISTEN queue_changed`; a change publishes `pg_notify` *inside its own
transaction*, so PostgreSQL withholds it until commit and discards it on rollback. Chosen over
ElastiCache Redis, which offers identical at-most-once semantics for real money and an extra failure
domain. Behind a `RealtimeBus` interface: `POSTGRES` everywhere deployed, `LOCAL` (in-JVM) in tests.

**`BroadcastCoordinator`** keeps the work off the listener thread — that thread only decodes and
hands off, because doing the refresh there serialised every queue behind every other and let one
slow client block them all. Refreshes run on virtual threads, at most one per queue in flight, behind
a 200 ms coalescing window. There is deliberately **no revision counter**: per-queue serialisation
already makes an older view unable to follow a newer one.

### Security

Two authorisation models. **Customers are anonymous**, authorised by an unguessable ticket token in
the URL — a capability, not an account, because "datos mínimos" is a requirement. **Staff** hold a
12-hour HS256 JWT; authorisation is *membership*, not a role claim in the token, so revoking access
takes effect on the next request. Errors are RFC 7807 with a stable machine-readable `code`.

### Frontend

Static export: `next build` writes `out/`, no Next server in production. The two customer URLs
(`/q/{queueId}`, `/t/{ticketToken}`) are printed on posters and sent in messages, so they keep clean
paths — each is a single shell page reading its id from the address bar, with a CloudFront Function
rewriting the path. Staff URLs use query strings and need no hosting configuration.

i18n is first-party: English is the source of truth, `MessageKey` derives from it, and Spanish is
typed as a complete record — **a missing translation is a build error**. The customer's locale is
stored on their entry so the email an hour later matches the page they joined from.

---

## 7. Measurements actually taken

Not estimates — these were measured on this machine and are safe to quote in the document.

| What | Result |
|---|---|
| Broadcast fan-out, before | `≈ 14 + 4 × watchers` SQL statements per queue movement |
| Broadcast fan-out, after | **Flat ~19–20**, independent of watchers. At 12 watchers: 66 → 19 |
| Cross-instance realtime | Two instances, one DB: customer streaming from A received a change made on B (3 SSE frames). With transport forced to `LOCAL`, the same update was **provably lost** (1 frame) |
| Graceful shutdown | Released 2 live SSE connections, then completed in **6 ms** — not the 25 s budget |
| `prod` profile with no config | **Exits non-zero**, naming the unresolved placeholder |
| i18n end to end | Three customers in one queue each received their own language, verified in Mailpit |

**Throughput reasoning:** ~20 statements per queue movement. A busy restaurant (40 waiting, a call
every two minutes) is **~1.5 queries/second**. Reaching 450/s would need ~3,000 people waiting across
100 active queues. The database is not the bottleneck — **open SSE connections on the app tier are**,
which is why `q.sse.connections` is exported as a metric.

---

## 8. AWS deployment

Runbook in [../infra/README.md](../infra/README.md). Summary:

**Target:** AWS Academy Learner Lab, `us-east-1`, ~$50 budget. The template creates **no IAM roles** —
it reuses `LabInstanceProfile`, because that environment forbids creating them.

**Shape:** VPC `10.0.0.0/16`, six subnets (three tiers × two AZs). Public holds the ALB and NAT
Gateway; private-app holds the ASG; private-DB holds RDS and **its route table has no `0.0.0.0/0`
entry at all**. One CloudFront distribution fronts the SPA from S3 and `/api/*` from the ALB, making
the whole product one HTTPS origin — no domain, no ACM, no CORS. An S3 Gateway Endpoint keeps artifact
downloads off the NAT.

**Cost ~$0.18/hour.** A 4-hour session is $0.70; two weeks running is $59 — more than the budget.
`delete-stack` between sessions, and **empty both buckets first** or the delete fails partway with the
NAT Gateway still billing.

**Services used:** VPC, subnets, route tables, IGW, NAT GW, S3 Gateway Endpoint, Security Groups,
NACLs, EC2, EBS, ALB, ASG, RDS, S3, CloudFront. **Deliberately not used:** SSM and CloudWatch (not yet
covered in class), Lambda, EFS, DynamoDB, read replicas.

**The three answers most likely to be asked:**

- *Why EC2 and not Lambda?* The app holds open SSE connections and a long-lived PostgreSQL `LISTEN`
  connection. Both need a process that stays alive; Lambda caps at 15 minutes and cannot hold a
  stream. The architecture *requires* persistent compute.
- *Why RDS and not DynamoDB?* Ordering is the product (position is a sorted range query); correctness
  depends on row locks; metrics are aggregations; and the database is also the message bus via
  LISTEN/NOTIFY. DynamoDB provides none of those four.
- *EBS or EFS?* EBS root volumes only. The instances share no files — QR codes are generated in
  memory, there are no uploads. Shared state lives in RDS, which is the point.

---

## 9. Documentation map

| File | Contents |
|---|---|
| [architecture.md](architecture.md) | The main design document. Request lifecycles, concurrency, ordering, lanes, realtime, security, deployment, and a **23-entry decision log** naming rejected alternatives |
| [domain-model.md](domain-model.md) | Entities, entry state machine, grace policies, lanes, estimation, metrics |
| [api-reference.md](api-reference.md) | Every endpoint, error code, the SSE contract, lane endpoints |
| [frontend.md](frontend.md) | Frontend implementation and design language |
| [gotchas.md](gotchas.md) | **Traps.** Teardown, cost, local setup, and code that looks wrong but isn't |
| [../infra/README.md](../infra/README.md) | Deployment runbook and demo script |

---

## 10. Working conventions

**Commit attribution.** Commits in this repository are Jose's alone — **never add a
`Co-Authored-By` trailer or any AI attribution**. This has been stated repeatedly and is recorded in
the project memory. Verify before pushing:

```bash
git log origin/main --format='%B%n%(trailers)' | grep -icE "claude|anthropic|co-authored"   # must be 0
```

**Pushing.** Port 22 is blocked from the agent shell on this machine. Use:

```bash
git -c url."ssh://git@ssh.github.com:443/".insteadOf="git@github.com:" push origin main
```

If the agent has no identities: `ssh-add --apple-load-keychain`.

**Commit style.** Prose explaining *why*, not bullet lists of what. Include measurements where they
exist. Look at recent history for the register.

**`.claude/` is gitignored** deliberately, so AI tooling config stays out of the repository.

**Tooling notes:** no AWS CLI installed locally (the Learner Lab console and CloudShell are the path);
`pip install` into system Python is blocked by PEP 668 — use a venv in the scratchpad.

---

## 11. Open items

**Blocking Entrega 2:**

1. **Write the PDF.** Most content exists across `architecture.md` and `infra/README.md`; the work is
   restructuring it into the exact headings the assignment names (§1) and exporting the diagram.
2. **Nobody has deployed the stack.** Budget the first `create-stack` generously — most likely
   failures are `AmiId` (region-specific, rotates) and `DbEngineVersion` (defaults to `16.4`, may not
   be offered).

**Known inconsistencies:**

3. **The infrastructure and the application disagree about packaging.** `infra/q-stack.yaml`
   user-data downloads a jar and runs it under systemd; the backend now ships a container started by
   `backend/queue-container.service`. Pick one before deploying.
4. **`docs/domain-model.md`'s lanes section is in Spanish** while the rest of that document is
   English. Harmless, but inconsistent.

**Deliberate deferrals** (decided, not forgotten):

5. `BackupRetentionPeriod: 0` and `DeletionProtection: false` — correct for a stack rebuilt every
   session, wrong for anything real. One line each.
6. **CloudWatch** — not yet covered in class. Consequence: with no SSH into the private subnets, a
   failed deployment is opaque. The escape hatch is three lines of user-data copying
   `/var/log/q-bootstrap.log` to the artifacts bucket.
7. **No frontend test suite.** Playwright against the real stack is the obvious next step.
8. `GraceSweepJob` runs on every instance — correct because of the per-queue lock, but duplicated
   work.

---

## 12. If you are picking this up cold

Read, in order: this file → [gotchas.md](gotchas.md) → [architecture.md](architecture.md) §§1–2 for
the shape, then whichever section covers what you are touching. `git log` messages carry the
reasoning for anything recent.

The single most useful thing to know: **almost every non-obvious choice here was measured or argued,
and the argument is written down.** Before changing something that looks odd, check the decision log
in `architecture.md` and the "code that looks wrong but isn't" table in `gotchas.md` — the reason is
probably already there.
