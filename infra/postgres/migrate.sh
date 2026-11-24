#!/bin/sh
set -eu

migrate() {
    PGPASSWORD="$2" goose -dir "/migrations/$1" postgres \
        "host=postgres user=${1}_app dbname=${1}_db sslmode=disable connect_timeout=5" up
}

migrate auth "$ASTRA_AUTH_DB_PASSWORD"
migrate problem "$ASTRA_PROBLEM_DB_PASSWORD"
migrate submission "$ASTRA_SUBMISSION_DB_PASSWORD"
