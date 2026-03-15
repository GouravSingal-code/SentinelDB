FROM postgres:16

# Install WAL-G (arm64 build) for PITR + supercronic for scheduled base backups
ARG WALG_VERSION=v3.0.8
ARG SUPERCRONIC_VERSION=v0.2.33
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-20.04-aarch64.tar.gz" \
      | tar xz -C /usr/local/bin && \
    mv /usr/local/bin/wal-g-pg-20.04-aarch64 /usr/local/bin/wal-g && \
    chmod +x /usr/local/bin/wal-g && \
    curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-arm64" \
      -o /usr/local/bin/supercronic && \
    chmod +x /usr/local/bin/supercronic && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    echo "container:x:1000:1000:container user:/var/lib/postgresql:/bin/bash" >> /etc/passwd && \
    echo "container:x:1000:" >> /etc/group

# Init script — creates replication user + configures WAL archiving (runs on first boot)
COPY init-replication.sh /docker-entrypoint-initdb.d/01-init-replication.sh

# PITR scripts
COPY wal-archive.sh /usr/local/bin/wal-archive.sh
COPY backup.sh      /usr/local/bin/backup.sh

# Custom entrypoint: starts cron if S3 is configured, then execs postgres
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x \
    /docker-entrypoint-initdb.d/01-init-replication.sh \
    /usr/local/bin/wal-archive.sh \
    /usr/local/bin/backup.sh \
    /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["postgres"]
