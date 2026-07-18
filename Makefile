COMPOSE_PROD := docker compose -p ailearn
COMPOSE_DEV := docker compose -p ailearn-dev -f docker-compose.dev.yml

# One-shot init containers (restart: "no") that exit after their task.
# They are waited on and then removed after every `up`/`dev`/`storage` so
# they don't linger as exited containers in `docker ps -a`.
#
# migrate / role-bootstrap / role-grants run on every startup to apply
# pending schema migrations and re-apply role grants.  They are idempotent
# no-ops when nothing changed, but must run every time — they are NOT
# first-time-only.  minio-init and seed-* are genuinely one-time and are
# already gated behind profiles.
PROD_INIT_SERVICES := role-bootstrap migrate role-grants
DEV_INIT_SERVICES := migrate
STORAGE_INIT_SERVICES := minio-init

.PHONY: up dev storage storage-dev seed-owner seed-demo down down-prod down-dev logs reset reset-dev \
	rebuild rebuild-dev config config-dev shell-api shell-web shell-worker \
	clean-init clean-init-dev

# Production-like stack: prod targets, non-root application users, no bind mounts.
up:
	$(COMPOSE_PROD) up -d --build
	$(MAKE) --no-print-directory clean-init

# Standalone local stack with dev targets, fixed local credentials and hot reload.
dev:
	$(COMPOSE_DEV) up -d --build
	$(MAKE) --no-print-directory clean-init-dev

storage:
	$(COMPOSE_PROD) --profile storage up -d --build
	$(MAKE) --no-print-directory clean-init
	@set -e; for svc in $(STORAGE_INIT_SERVICES); do \
		cid="$$( $(COMPOSE_PROD) ps -aq $$svc )"; \
		if [ -n "$$cid" ]; then $(COMPOSE_PROD) wait $$svc >/dev/null; fi; \
	done
	@$(COMPOSE_PROD) rm -f $(STORAGE_INIT_SERVICES) 2>/dev/null || true

storage-dev:
	$(COMPOSE_DEV) --profile storage up -d --build
	$(MAKE) --no-print-directory clean-init-dev
	@set -e; for svc in $(STORAGE_INIT_SERVICES); do \
		cid="$$( $(COMPOSE_DEV) ps -aq $$svc )"; \
		if [ -n "$$cid" ]; then $(COMPOSE_DEV) wait $$svc >/dev/null; fi; \
	done
	@$(COMPOSE_DEV) rm -f $(STORAGE_INIT_SERVICES) 2>/dev/null || true

# Wait for the production init containers to exit, then remove them so they
# don't linger in `docker ps -a`.  `docker compose wait` blocks until the
# one-shot container stops; if it already exited (or was never created) the
# command returns immediately. A non-zero init exit is deliberately propagated
# and the failed container is preserved so its logs remain available.
clean-init:
	@set -e; for svc in $(PROD_INIT_SERVICES); do \
		cid="$$( $(COMPOSE_PROD) ps -aq $$svc )"; \
		if [ -n "$$cid" ]; then $(COMPOSE_PROD) wait $$svc >/dev/null; fi; \
	done
	@$(COMPOSE_PROD) rm -f $(PROD_INIT_SERVICES) 2>/dev/null || true

# Same as clean-init but for the dev stack (only `migrate` is one-shot here).
clean-init-dev:
	@set -e; for svc in $(DEV_INIT_SERVICES); do \
		cid="$$( $(COMPOSE_DEV) ps -aq $$svc )"; \
		if [ -n "$$cid" ]; then $(COMPOSE_DEV) wait $$svc >/dev/null; fi; \
	done
	@$(COMPOSE_DEV) rm -f $(DEV_INIT_SERVICES) 2>/dev/null || true

# Production seed fails when OWNER_EMAIL or OWNER_PASSWORD is absent.
# Uses --rm so the container is removed immediately after seeding.
seed-owner:
	$(COMPOSE_PROD) --profile seed run --rm seed-owner

# Explicitly creates owner@ailearn.local / ailearn_owner in development only.
# Uses --rm so the container is removed immediately after seeding.
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
	$(MAKE) up

reset-dev:
	$(COMPOSE_DEV) down -v --remove-orphans
	$(MAKE) dev

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
