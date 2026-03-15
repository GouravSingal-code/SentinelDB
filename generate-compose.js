#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────
// Single source of truth for all scaling values.
// Edit here — the YAML is fully derived from this config.
// Run: node generate-compose.js
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

// Load .env if present (no extra dependencies needed)
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, "utf8").split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val; // don't override shell env
  });
}

if (!process.env.AWS_ACCOUNT_ID) {
  console.error("❌ AWS_ACCOUNT_ID is not set. Copy .env.example → .env and fill it in.");
  process.exit(1);
}

const config = {
  // ── pgbouncer-write (fronts primary Postgres — all writes) ─────────────────
  pgbouncerWriteMaxReplicas: 2,
  pgbouncerWritePoolSizePerPod: 20,  // real server-side connections to postgres per pod
  pgbouncerWriteHeadroom: 15,        // reserved slack in postgres max_connections
  pgbouncerWriteMaxClientConn: 1000, // client-side connections from API (pgbouncer queues these cheaply)

  // ── pgbouncer-read (fronts postgres-replica — all reads) ───────────────────
  pgbouncerReadMaxReplicas: 3,
  pgbouncerReadPoolSizePerPod: 20,   // real server-side connections to replica per pod
  pgbouncerReadHeadroom: 15,         // reserved slack in replica max_connections
  pgbouncerReadMaxClientConn: 1000,  // client-side connections from API (pgbouncer queues these cheaply)

  // ── API ────────────────────────────────────────────────────────────────────
  // These are independent of pgbouncer math — tune based on workload, not DB limits.
  // PgBouncer decouples client connections from server connections.
  apiMaxReplicas: 10,
  apiWritePoolPerPod: 10,  // concurrent write connections per API pod → pgbouncer (not postgres)
  apiReadPoolPerPod: 20,   // concurrent read connections per API pod  → pgbouncer (not postgres)

  // ── Images ─────────────────────────────────────────────────────────────────
  pgbouncerImage:       "gorspeed/pgbouncer:v1.0.5",
  postgresPrimaryImage: "gorspeed/postgres-primary:v1.0.11",  // built from postgres-primary/
  postgresReplicaImage: "gorspeed/postgres-replica:v1.0.2",  // built from postgres-replica/
  apiImage:             "gorspeed/paas-api:v1.0.4",

  // ── AWS — loaded from .env, never hardcoded ────────────────────────────────
  awsAccountId: process.env.AWS_ACCOUNT_ID,

  // ── PITR — optional, loaded from .env ─────────────────────────────────────
  // Set WALG_S3_PREFIX=s3://your-bucket/walg/prod in .env to enable WAL archiving.
  // If not set, PITR is disabled and the deployment works exactly as before.
  walgS3Prefix:  process.env.WALG_S3_PREFIX  || "",
  walgAwsRegion: process.env.WALG_AWS_REGION || "ap-south-1",
  // For S3 auth: either set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in .env,
  // or attach an IAM role to the EC2 instance (preferred in production).
  walgAccessKeyId:     process.env.WALG_AWS_ACCESS_KEY_ID     || "",
  walgSecretAccessKey: process.env.WALG_AWS_SECRET_ACCESS_KEY || "",

  // ── Backup tuning — optional, defaults are production-safe ────────────────
  backupCronSchedule:      process.env.BACKUP_CRON_SCHEDULE        || "0 2 * * *",
  walgBackupRetentionFull: process.env.WALG_BACKUP_RETENTION_FULL  || "7",
  archiveTimeout:          process.env.ARCHIVE_TIMEOUT             || "60",
};

// ── Derived constraints ────────────────────────────────────────────────────────
// Only constraint that matters: pgbouncer server pool × max replicas < postgres max_connections.
// API pool sizes are independent — pgbouncer queues client connections, decoupling API from postgres.
const postgresMaxConn        = (config.pgbouncerWriteMaxReplicas * config.pgbouncerWritePoolSizePerPod) + config.pgbouncerWriteHeadroom;
const postgresReplicaMaxConn = (config.pgbouncerReadMaxReplicas  * config.pgbouncerReadPoolSizePerPod)  + config.pgbouncerReadHeadroom;
const totalWritePgConn       = config.pgbouncerWriteMaxReplicas * config.pgbouncerWritePoolSizePerPod;
const totalReadPgConn        = config.pgbouncerReadMaxReplicas  * config.pgbouncerReadPoolSizePerPod;

// ── Validation ────────────────────────────────────────────────────────────────
if (totalWritePgConn >= postgresMaxConn) {
  console.error(`❌ Write constraint violated: pgbouncer-write(${config.pgbouncerWriteMaxReplicas} × ${config.pgbouncerWritePoolSizePerPod} = ${totalWritePgConn}) ≥ postgres max_connections(${postgresMaxConn})`);
  process.exit(1);
}
if (totalReadPgConn >= postgresReplicaMaxConn) {
  console.error(`❌ Read constraint violated: pgbouncer-read(${config.pgbouncerReadMaxReplicas} × ${config.pgbouncerReadPoolSizePerPod} = ${totalReadPgConn}) ≥ replica max_connections(${postgresReplicaMaxConn})`);
  process.exit(1);
}

console.log(`✓ Write path: postgres max_connections=${postgresMaxConn} ≥ pgbouncer-write(${config.pgbouncerWriteMaxReplicas}×${config.pgbouncerWritePoolSizePerPod}=${totalWritePgConn}) + headroom(${config.pgbouncerWriteHeadroom})`);
console.log(`✓ Read  path: replica max_connections=${postgresReplicaMaxConn} ≥ pgbouncer-read(${config.pgbouncerReadMaxReplicas}×${config.pgbouncerReadPoolSizePerPod}=${totalReadPgConn}) + headroom(${config.pgbouncerReadHeadroom})`);
console.log(`✓ pgbouncer-write MAX_CLIENT_CONN=${config.pgbouncerWriteMaxClientConn} (client-facing, decoupled from postgres)`);
console.log(`✓ pgbouncer-read  MAX_CLIENT_CONN=${config.pgbouncerReadMaxClientConn} (client-facing, decoupled from postgres)\n`);

// ── Generate YAML ─────────────────────────────────────────────────────────────
const yaml = `version: "3.9"

# ─────────────────────────────────────────────────────────────
# OMNISTRATE PAAS SERVICE
# Architecture:
#
#   api (writePool) → pgbouncer-write → postgres          (primary, single writer)
#   api (readPool)  → pgbouncer-read  → postgres-replica  (streaming standby)
#
# ⚠️  DO NOT EDIT THIS FILE DIRECTLY.
#     Generated by: node generate-compose.js
#
# SCALING CONSTRAINTS (auto-derived):
#   Write: postgres max_connections=${postgresMaxConn} ≥ pgbouncer-write(${config.pgbouncerWriteMaxReplicas}×${config.pgbouncerWritePoolSizePerPod}=${totalWritePgConn}) + headroom(${config.pgbouncerWriteHeadroom})
#   Read:  replica max_connections=${postgresReplicaMaxConn} ≥ pgbouncer-read(${config.pgbouncerReadMaxReplicas}×${config.pgbouncerReadPoolSizePerPod}=${totalReadPgConn}) + headroom(${config.pgbouncerReadHeadroom})
#   pgbouncer-write MAX_CLIENT_CONN=${config.pgbouncerWriteMaxClientConn} (client-facing, set independently of API pool)
#   pgbouncer-read  MAX_CLIENT_CONN=${config.pgbouncerReadMaxClientConn} (client-facing, set independently of API pool)
# ─────────────────────────────────────────────────────────────

services:

  # ───────────────────────────────────────────
  # 1. PostgreSQL Primary — write path only
  #    Streams WAL to postgres-replica continuously.
  # ───────────────────────────────────────────
  postgres:
    image: ${config.postgresPrimaryImage}
    command: >
      postgres
        -c max_connections=${postgresMaxConn}
        -c wal_level=replica
        -c max_wal_senders=5
        -c max_replication_slots=3
    environment:
      - POSTGRES_USER=app
      - POSTGRES_PASSWORD=\$var.dbPassword
      - POSTGRES_DB=appdb
      - REPLICATOR_PASSWORD=\$var.replicatorPassword
      - WALG_S3_PREFIX=${config.walgS3Prefix}
      - AWS_REGION=${config.walgAwsRegion}
      ${config.walgAccessKeyId     ? `- AWS_ACCESS_KEY_ID=${config.walgAccessKeyId}`     : "# AWS_ACCESS_KEY_ID — using IAM instance role"}
      ${config.walgSecretAccessKey ? `- AWS_SECRET_ACCESS_KEY=${config.walgSecretAccessKey}` : "# AWS_SECRET_ACCESS_KEY — using IAM instance role"}
      - BACKUP_CRON_SCHEDULE=${config.backupCronSchedule}
      - WALG_BACKUP_RETENTION_FULL=${config.walgBackupRetentionFull}
      - ARCHIVE_TIMEOUT=${config.archiveTimeout}
    expose:
      - "5432"
    volumes:
      - source: pg_data
        target: /var/lib/postgresql/data
        type: volume
        x-omnistrate-storage:
          aws:
            instanceStorageType: AWS::EBS_GP3
            instanceStorageSizeGi: 20
            instanceStorageIOPS: 3000
            instanceStorageThroughputMiBps: 125

    x-omnistrate-compute:
      instanceTypes:
        - cloudProvider: aws
          name: t4g.small

    x-omnistrate-capabilities: {}

    x-omnistrate-mode-internal: true

    x-omnistrate-actionhooks:
      - scope: NODE
        type: HEALTH_CHECK
        commandTemplate: |
          nc -z localhost 5432

    x-omnistrate-api-params:
      - key: dbPassword
        name: Database Password
        description: Password for the PostgreSQL app user
        type: String
        required: true
        modifiable: false
        export: false
      - key: replicatorPassword
        name: Replication Password
        description: Password for the PostgreSQL streaming replication user
        type: String
        required: true
        modifiable: false
        export: false

  # ───────────────────────────────────────────
  # 2. PostgreSQL Replica — read path only
  #    Custom image runs pg_basebackup on first boot,
  #    then streams WAL from primary continuously.
  # ───────────────────────────────────────────
  postgres-replica:
    image: ${config.postgresReplicaImage}
    environment:
      - PRIMARY_HOST=postgres
      - REPLICATOR_PASSWORD=\$var.replicatorPassword
      - POSTGRES_USER=app
      - POSTGRES_PASSWORD=\$var.dbPassword
      - POSTGRES_DB=appdb
      - MAX_CONNECTIONS=${postgresReplicaMaxConn}
    expose:
      - "5432"
    volumes:
      - source: pg_replica_data
        target: /var/lib/postgresql/data
        type: volume
        x-omnistrate-storage:
          aws:
            instanceStorageType: AWS::EBS_GP3
            instanceStorageSizeGi: 20
            instanceStorageIOPS: 3000
            instanceStorageThroughputMiBps: 125

    x-omnistrate-compute:
      instanceTypes:
        - cloudProvider: aws
          name: t4g.small

    x-omnistrate-capabilities: {}

    x-omnistrate-mode-internal: true

    x-omnistrate-actionhooks:
      - scope: NODE
        type: HEALTH_CHECK
        commandTemplate: |
          nc -z localhost 5432

    x-omnistrate-api-params:
      - key: replicatorPassword
        name: Replication Password
        description: Password for the PostgreSQL streaming replication user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          postgres: replicatorPassword
      - key: dbPassword
        name: Database Password
        description: Password for the PostgreSQL app user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          postgres: dbPassword

    depends_on:
      - postgres

  # ───────────────────────────────────────────
  # 3. PgBouncer Write — fronts the primary
  #    MAX_CLIENT_CONN = ${config.pgbouncerWriteMaxClientConn}
  #    DEFAULT_POOL_SIZE = ${config.pgbouncerWritePoolSizePerPod} per pod
  # ───────────────────────────────────────────
  pgbouncer-write:
    image: ${config.pgbouncerImage}
    environment:
      - DB_USER=app
      - DB_PASSWORD=\$var.dbPassword
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_NAME=appdb
      - POOL_MODE=transaction
      - MAX_CLIENT_CONN=${config.pgbouncerWriteMaxClientConn}
      - DEFAULT_POOL_SIZE=${config.pgbouncerWritePoolSizePerPod}
      - AUTH_TYPE=md5
    expose:
      - "5432"

    x-omnistrate-compute:
      instanceTypes:
        - cloudProvider: aws
          name: t4g.small

    x-omnistrate-capabilities:
      autoscaling:
        minReplicas: 1
        maxReplicas: ${config.pgbouncerWriteMaxReplicas}
        overUtilizedThreshold: 70
        overUtilizedMinutesBeforeScalingUp: 2
        idleThreshold: 20
        idleMinutesBeforeScalingDown: 5

    x-omnistrate-mode-internal: true

    x-omnistrate-api-params:
      - key: dbPassword
        name: Database Password
        description: Password for the PostgreSQL app user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          postgres: dbPassword
      - key: replicatorPassword
        name: Replication Password
        description: Password for the PostgreSQL streaming replication user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          postgres: replicatorPassword

    depends_on:
      - postgres

  # ───────────────────────────────────────────
  # 4. PgBouncer Read — fronts the replica
  #    MAX_CLIENT_CONN = ${config.pgbouncerReadMaxClientConn}
  #    DEFAULT_POOL_SIZE = ${config.pgbouncerReadPoolSizePerPod} per pod
  # ───────────────────────────────────────────
  pgbouncer-read:
    image: ${config.pgbouncerImage}
    environment:
      - DB_USER=app
      - DB_PASSWORD=\$var.dbPassword
      - DB_HOST=postgres-replica
      - DB_PORT=5432
      - DB_NAME=appdb
      - POOL_MODE=transaction
      - MAX_CLIENT_CONN=${config.pgbouncerReadMaxClientConn}
      - DEFAULT_POOL_SIZE=${config.pgbouncerReadPoolSizePerPod}
      - AUTH_TYPE=md5
    expose:
      - "5432"

    x-omnistrate-compute:
      instanceTypes:
        - cloudProvider: aws
          name: t4g.small

    x-omnistrate-capabilities:
      autoscaling:
        minReplicas: 1
        maxReplicas: ${config.pgbouncerReadMaxReplicas}
        overUtilizedThreshold: 70
        overUtilizedMinutesBeforeScalingUp: 2
        idleThreshold: 20
        idleMinutesBeforeScalingDown: 5

    x-omnistrate-mode-internal: true

    x-omnistrate-api-params:
      - key: dbPassword
        name: Database Password
        description: Password for the PostgreSQL app user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          postgres-replica: dbPassword
      - key: replicatorPassword
        name: Replication Password
        description: Password for the PostgreSQL streaming replication user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          postgres-replica: replicatorPassword

    depends_on:
      - postgres-replica

  # ───────────────────────────────────────────
  # 5. API — stateless, public
  #    writePool → pgbouncer-write → postgres
  #    readPool  → pgbouncer-read  → postgres-replica
  # ───────────────────────────────────────────
  api:
    image: ${config.apiImage}
    environment:
      - DB_PASSWORD=\$var.dbPassword
      - DB_WRITE_HOST=pgbouncer-write
      - DB_READ_HOST=pgbouncer-read
      - DB_PORT=5432
      - DB_USER=app
      - DB_NAME=appdb
      - DB_WRITE_POOL_SIZE=${config.apiWritePoolPerPod}
      - DB_READ_POOL_SIZE=${config.apiReadPoolPerPod}
      - PORT=8080
      - ENV=production
    ports:
      - "8080:8080"

    x-omnistrate-compute:
      instanceTypes:
        - cloudProvider: aws
          name: t4g.small

    x-omnistrate-capabilities:
      autoscaling:
        minReplicas: 1
        maxReplicas: ${config.apiMaxReplicas}
        overUtilizedThreshold: 70
        overUtilizedMinutesBeforeScalingUp: 2
        idleThreshold: 20
        idleMinutesBeforeScalingDown: 5
      httpReverseProxy:
        targetPort: 8080

    x-omnistrate-actionhooks:
      - scope: NODE
        type: HEALTH_CHECK
        commandTemplate: |
          wget -qO- http://localhost:8080/health

    x-omnistrate-api-params:
      - key: dbPassword
        name: Database Password
        description: Password for the PostgreSQL app user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          pgbouncer-write: dbPassword
          pgbouncer-read: dbPassword
      - key: replicatorPassword
        name: Replication Password
        description: Password for the PostgreSQL streaming replication user
        type: String
        required: true
        modifiable: false
        export: false
        parameterDependencyMap:
          pgbouncer-write: replicatorPassword
          pgbouncer-read: replicatorPassword

    depends_on:
      - pgbouncer-write
      - pgbouncer-read

volumes:
  pg_data:
  pg_replica_data:

x-omnistrate-service-plan:
  name: "PaaS Service"
  tenancyType: "OMNISTRATE_DEDICATED_TENANCY"
  deployment:
    hostedDeployment:
      awsAccountId: "${config.awsAccountId}"
`;

const outPath = path.join(__dirname, "omnistrate-compose.yaml");
fs.writeFileSync(outPath, yaml);
console.log(`✅ Written to ${outPath}`);
