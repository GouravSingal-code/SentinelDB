# Omnistrate PaaS — PostgreSQL Service

A production-style database-as-a-service built on [Omnistrate](https://omnistrate.com). It provisions a managed PostgreSQL cluster with read replicas, connection pooling, automated backups, and a REST API — all deployed and scaled through Omnistrate.

---

## What This Project Does

When you deploy this, you get:

- **PostgreSQL primary** — handles all writes
- **PostgreSQL replica** — handles all reads, stays in sync with the primary via streaming replication
- **PgBouncer (write)** — sits in front of the primary; pools connections so the API doesn't overwhelm Postgres
- **PgBouncer (read)** — same idea, but in front of the replica
- **REST API** — a Node.js app that routes writes to the primary and reads to the replica automatically. Includes a circuit breaker: if the replica goes down, reads automatically fall back to the primary
- **PITR (Point-In-Time Recovery)** — WAL-G continuously ships WAL segments to S3, and takes a full base backup every night. If something goes wrong, you can restore the database to any point in time

```
Client → API → pgbouncer-write → postgres (primary)   [writes]
             → pgbouncer-read  → postgres-replica      [reads]

postgres (primary) → WAL stream → postgres-replica     [replication]
postgres (primary) → WAL-G      → S3                   [backups / PITR]
```

---

## Project Structure

```
paas-service/
├── generate-compose.js        # Generates the Omnistrate compose YAML; validates connection math
├── omnistrate-compose.yaml    # Generated — do not edit directly
├── .env.example               # Copy to .env and fill in your values
├── instance-params.json       # Passwords passed at deploy time (git-ignored)
├── api/                       # Node.js REST API (Express + pg + circuit breaker)
├── postgres-primary/          # Custom postgres image: WAL-G + supercronic + PITR scripts
├── postgres-replica/          # Custom postgres image: pg_basebackup + standby mode
└── pgbouncer/                 # PgBouncer image with runtime-generated config
```

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with buildx support
- [Node.js](https://nodejs.org/) v18+
- [Omnistrate account](https://omnistrate.com) + `omnistrate-ctl` CLI installed
- AWS account with an S3 bucket (for PITR backups)
- Docker Hub account (to push images)

---

## Setup

### 1. Clone the repo

```bash
git clone <repo-url>
cd paas-service
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `AWS_ACCOUNT_ID` — your AWS account ID
- `WALG_S3_PREFIX` — S3 path for backups, e.g. `s3://your-bucket/walg/prod`
- `WALG_AWS_REGION` — AWS region of your S3 bucket

> AWS credentials are not needed here. Omnistrate provisions IAM Roles for Service Accounts (IRSA) automatically, and WAL-G picks them up.

### 3. Create instance-params.json

This file holds the database passwords and is never committed.

```bash
cat > instance-params.json << 'EOF'
{
  "dbPassword": "your-strong-db-password",
  "replicatorPassword": "your-strong-replicator-password"
}
EOF
```

---

## Build & Deploy

### Step 1 — Build and push Docker images

```bash
# PostgreSQL primary (includes WAL-G + supercronic for PITR)
cd postgres-primary
docker buildx build --platform linux/arm64 -t <your-dockerhub>/postgres-primary:v1.0.0 --push .

# PostgreSQL replica
cd ../postgres-replica
docker buildx build --platform linux/arm64 -t <your-dockerhub>/postgres-replica:v1.0.0 --push .

# PgBouncer
cd ../pgbouncer
docker buildx build --platform linux/arm64 -t <your-dockerhub>/pgbouncer:v1.0.0 --push .

# API
cd ../api
docker buildx build --platform linux/arm64 -t <your-dockerhub>/paas-api:v1.0.0 --push .
```

> Built for `linux/arm64` (AWS Graviton / t4g instances). Change to `linux/amd64` if using x86 nodes.

### Step 2 — Update image tags in generate-compose.js

Open `generate-compose.js` and update the image names in the `config` object to match what you pushed.

### Step 3 — Generate the Omnistrate compose YAML

```bash
node generate-compose.js
```

This validates the connection pool math and writes `omnistrate-compose.yaml`.

### Step 4 — Publish the service to Omnistrate

```bash
omnistrate-ctl build \
  --file omnistrate-compose.yaml \
  --product-name "PaaS Service" \
  --environment Dev \
  --environment-type dev \
  --release-as-preferred \
  --release-description "Initial deployment"
```

### Step 5 — Create an instance

```bash
omnistrate-ctl instance create \
  --service "PaaS Service" \
  --environment "Dev" \
  --plan "PaaS Service" \
  --version preferred \
  --resource api \
  --cloud-provider aws \
  --region ap-south-1 \
  --param-file instance-params.json
```

After a couple of minutes, the instance will be ready. Omnistrate provisions EC2 nodes, EBS volumes, and a load balancer automatically.

---

## API Endpoints

Once deployed, Omnistrate gives you a public HTTPS endpoint for the API.

```
GET  /health                    → { status, write, read }
GET  /items?limit=50&offset=0   → list items, paginated (reads from replica)
GET  /items/:id                 → get one item   (reads from replica)
POST /items                     → create item    (writes to primary)
PUT  /items/:id                 → update item    (writes to primary)
DELETE /items/:id               → delete item    (writes to primary)
```

Example:
```bash
BASE=https://api.<instance-id>.<cluster>.ap-south-1.aws.<domain>.cloud

curl $BASE/health
curl -X POST $BASE/items -H "Content-Type: application/json" -d '{"name":"test","value":"hello"}'
curl $BASE/items
```

---

## Rolling Updates (no downtime)

When you change an image or config:

```bash
# 1. Bump the image tag in generate-compose.js
# 2. Build and push the new image
# 3. Regenerate the YAML
node generate-compose.js

# 4. Publish new version
omnistrate-ctl build --file omnistrate-compose.yaml \
  --product-name "PaaS Service" --environment Dev --environment-type dev \
  --release-as-preferred --release-description "describe your change"

# 5. Apply to the running instance (Omnistrate rolls pods one by one)
omnistrate-ctl instance version-upgrade instance-<id> --target-tier-version preferred --wait
```

---

## PITR — Backups and Recovery

**Check WAL archiving status:**
```bash
kubectl exec postgres-0 -n instance-<id> -c service -- \
  psql -U app -d appdb -c "SELECT last_archived_wal, last_archived_time, failed_count FROM pg_stat_archiver;"
```

**Trigger a manual base backup:**
```bash
kubectl exec postgres-0 -n instance-<id> -c service -- /usr/local/bin/backup.sh
```

**List backups in S3:**
```bash
kubectl exec postgres-0 -n instance-<id> -c service -- wal-g backup-list
```

**Restore to a point in time** (run on a fresh empty data dir):
```bash
wal-g backup-fetch $PGDATA LATEST
echo "restore_command = 'wal-g wal-fetch %f %p'" >> $PGDATA/postgresql.auto.conf
echo "recovery_target_time = '2026-03-15 10:00:00'" >> $PGDATA/postgresql.auto.conf
touch $PGDATA/recovery.signal
# Start postgres — it replays WAL up to that timestamp, then opens for reads/writes
```

---

## Connection Pool Math

The connection limits are calculated automatically in `generate-compose.js`:

```
postgres max_connections = (pgbouncer replicas × pool size per pod) + headroom
```

The API pool size is independent — PgBouncer queues excess client connections, so the API can have more concurrent connections than Postgres allows without causing errors.

If the numbers don't add up, `node generate-compose.js` will fail with a clear error before generating the YAML.
