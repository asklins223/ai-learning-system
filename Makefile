COMPOSE_PROD := docker compose -p ailearn
COMPOSE_DEV := docker compose -p ailearn-dev -f docker-compose.dev.yml

.PHONY: up dev storage storage-dev seed-owner seed-demo down down-prod down-dev logs reset reset-dev \
	rebuild rebuild-dev config config-dev shell-api shell-web shell-worker

# Production-like stack: prod targets, non-root application users, no bind mounts.
up:
	$(COMPOSE_PROD) up -d --build

# Standalone local stack with dev targets, fixed local credentials and hot reload.
dev:
	$(COMPOSE_DEV) up -d --build

storage:
	$(COMPOSE_PROD) --profile storage up -d --build

storage-dev:
	$(COMPOSE_DEV) --profile storage up -d --build

# Production seed fails when OWNER_EMAIL or OWNER_PASSWORD is absent.
seed-owner:
	$(COMPOSE_PROD) --profile seed run --rm seed-owner

# Explicitly creates owner@ailearn.local / ailearn_owner in development only.
seed-demo:
	$(COMPOSE_DEV) --profile seed run --rm seed-demo

# Backward-compatible alias: `make down` stops only the production project.
down: down-prod

down-prod:
	$(COMPOSE_PROD) down --remove-orphans

down-dev:
	$(COMPOSE_DEV) down --remove-orphans

logs:
	$(COMPOSE_DEV) logs -f

reset:
	$(COMPOSE_PROD) down -v --remove-orphans
	$(COMPOSE_PROD) up -d --build

reset-dev:
	$(COMPOSE_DEV) down -v --remove-orphans
	$(COMPOSE_DEV) up -d --build

rebuild:
	$(COMPOSE_PROD) build --no-cache

rebuild-dev:
	$(COMPOSE_DEV) build --no-cache

config:
	$(COMPOSE_PROD) config --quiet

config-dev:
	$(COMPOSE_DEV) config --quiet

shell-api:
	$(COMPOSE_DEV) exec api sh

shell-web:
	$(COMPOSE_DEV) exec web sh

shell-worker:
	$(COMPOSE_DEV) exec worker sh
