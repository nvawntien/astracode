COMPOSE := docker compose --profile dev --profile worker

.PHONY: help up down start stop restart build logs ps migrate seed test test-quick test-db spec-validate

help:
	@printf '%s\n' \
	  'make help                        List development commands' \
	  'make up                          Build and start the development stack' \
	  'make down                        Stop the stack and keep volumes' \
	  'make start                       Build and start the stack (alias for up)' \
	  'make stop                        Stop the stack and keep containers and volumes' \
	  'make restart                     Recreate the stack through normal startup' \
	  'make build [SERVICE=...]          Build local images' \
	  'make logs [SERVICE=...]           Follow container logs' \
	  'make ps [SERVICE=...]             Show container status' \
	  'make migrate                     Run the one-shot Goose service' \
	  'make seed                        Seed curated tags in the migrated local database' \
	  'make test                        Run full repository verification' \
	  'make test-quick                  Run quick repository verification' \
	  'make test-db                     Run PostgreSQL integration suites' \
	  'make spec-validate               Validate all OpenSpec specs and changes'

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

start: up

stop:
	$(COMPOSE) stop

restart:
	$(COMPOSE) down
	$(COMPOSE) up -d --build

build:
	$(COMPOSE) build $(SERVICE)

logs:
	$(COMPOSE) logs -f $(SERVICE)

ps:
	$(COMPOSE) ps $(SERVICE)

migrate:
	docker compose run --build --rm migrate

seed:
	@set -e; \
	  address="$$(docker compose port postgres 5432)"; \
	  password="$$(docker compose exec -T postgres printenv ASTRA_PROBLEM_DB_PASSWORD)"; \
	  cd services/problem; \
	  DATABASE_HOST=127.0.0.1 DATABASE_PORT="$${address##*:}" \
	    DATABASE_USER=problem_app DATABASE_PASSWORD="$$password" go run ./cmd/seed-tags

test:
	bash scripts/verify.sh

test-quick:
	QUICK=1 bash scripts/verify.sh

test-db:
	bash scripts/test-postgres-integration.sh

spec-validate:
	openspec validate --all --strict --no-interactive
