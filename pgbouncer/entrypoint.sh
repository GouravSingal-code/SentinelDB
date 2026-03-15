#!/bin/sh
set -e

mkdir -p /tmp/pgbouncer

# Write userlist
echo "\"${DB_USER}\" \"${DB_PASSWORD}\"" > /tmp/pgbouncer/userlist.txt

# Write config — no 'user' directive so pgbouncer does not try to drop privileges
cat > /tmp/pgbouncer/pgbouncer.ini << EOF
[databases]
${DB_NAME} = host=${DB_HOST} port=${DB_PORT:-5432} dbname=${DB_NAME}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${LISTEN_PORT:-5432}
auth_type = ${AUTH_TYPE:-md5}
auth_file = /tmp/pgbouncer/userlist.txt
pool_mode = ${POOL_MODE:-transaction}
max_client_conn = ${MAX_CLIENT_CONN:-1000}
default_pool_size = ${DEFAULT_POOL_SIZE:-20}
server_reset_query =
ignore_startup_parameters = extra_float_digits
EOF

exec pgbouncer /tmp/pgbouncer/pgbouncer.ini
