COMPOSE := docker compose -p ailearn-dev -f docker-compose.dev.yml
DEV_DB_VOLUME := ailearn-dev_dev_postgres_data
.DEFAULT_GOAL := up

# One-shot init containers (restart: "no") that exit after their task.
# Stale containers are removed at the START of each `up`/`storage` run
# so that `docker compose up` always recreates them with the latest image.
# After they exit they are LEFT IN PLACE (as exited containers) so that
# Docker Desktop's "Start" button (`docker compose start`) can restart the
# entire stack — including re-running migrations — without error.
#
# migrate / role-bootstrap run on every startup to apply pending schema
# migrations and re-apply role grants.  They are idempotent no-ops when
# nothing changed, but must run every time — they are NOT
# first-time-only.  minio-init and seed-* are genuinely one-time and are
# already gated behind profiles.
INIT_SERVICES := role-bootstrap migrate
STORAGE_INIT_SERVICES := minio-init

# Include the storage profile in every dev `up` so that avatar/note image
# uploads work out of the box without a separate `make storage` step.
DEV_PROFILES := --profile storage

.PHONY: up dev storage storage-dev seed-demo down down-dev logs reset reset-dev reset-db \
	rebuild rebuild-dev config config-dev clean-init clean-init-dev \
	ensure-db-volume \
	shell-api shell-web shell-worker version-check verify release-check \
	coverage-gate skip-todo-gate release-manifest \
	alpha-up alpha-down alpha-backup alpha-restore-verify alpha-status alpha-metrics

# Local development stack: dev image targets, source bind mounts and hot
# reload.  This is the default `make up` target — there is no separate
# production stack for local use anymore.  CI still builds production images
# from docker-compose.yml directly (see .github/workflows/ci.yml), but that
# file is no longer wired to any local Makefile target.
ensure-db-volume:
	@set -e; if ! docker volume inspect "$(DEV_DB_VOLUME)" >/dev/null 2>&1; then \
		docker volume create \
			--label com.ailearn.protected=true \
			--label com.ailearn.purpose=postgres-data \
			"$(DEV_DB_VOLUME)" >/dev/null; \
		echo "Created protected database volume $(DEV_DB_VOLUME)"; \
	fi

up: ensure-db-volume
	-$(COMPOSE) rm -f $(INIT_SERVICES) $(STORAGE_INIT_SERVICES) 2>/dev/null
	$(COMPOSE) $(DEV_PROFILES) up -d --build
	@set -e; for svc in $(INIT_SERVICES) $(STORAGE_INIT_SERVICES); do \
		cid="$$( $(COMPOSE) ps -aq $$svc )"; \
		if [ -z "$$cid" ]; then echo "Missing required init service: $$svc" >&2; exit 1; fi; \
		$(COMPOSE) wait $$svc >/dev/null; \
	done

# Backward-compatible alias.
dev: up

storage: ensure-db-volume
	-$(COMPOSE) rm -f $(INIT_SERVICES) $(STORAGE_INIT_SERVICES) 2>/dev/null
	$(COMPOSE) --profile storage up -d --build
	@set -e; for svc in $(INIT_SERVICES) $(STORAGE_INIT_SERVICES); do \
		cid="$$( $(COMPOSE) ps -aq $$svc )"; \
		if [ -z "$$cid" ]; then echo "Missing required init service: $$svc" >&2; exit 1; fi; \
		$(COMPOSE) wait $$svc >/dev/null; \
	done

storage-dev: storage

# Manually remove stale one-shot init containers.  This is NOT called
# automatically by `up` — init containers are left in place after they
# exit so that Docker Desktop's "Start" button can restart the stack.
# Stale containers are instead removed at the beginning of the next
# `up`/`storage` run.
clean-init:
	@$(COMPOSE) rm -f $(INIT_SERVICES) 2>/dev/null || true

clean-init-dev: clean-init

# Explicitly creates owner@ailearn.local / ailearn_owner in development only.
# Uses --rm so the container is removed immediately after seeding.
seed-demo: ensure-db-volume
	$(COMPOSE) --profile seed run --rm seed-demo

down:
	$(COMPOSE) down --remove-orphans

down-dev: down

logs:
	$(COMPOSE) logs -f

reset reset-dev:
	@echo "Refusing to delete the development database from the legacy '$@' target."; \
		echo "Use: make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB"; \
		exit 2

reset-db:
	@if [ "$(CONFIRM_RESET_DB)" != "DELETE_DEV_DB" ]; then \
		echo "Database reset cancelled; no data was changed."; \
		echo "To permanently delete $(DEV_DB_VOLUME), run:"; \
		echo "  make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB"; \
		exit 2; \
	fi
	$(COMPOSE) down --remove-orphans
	@if docker volume inspect "$(DEV_DB_VOLUME)" >/dev/null 2>&1; then \
		docker volume rm "$(DEV_DB_VOLUME)"; \
	else \
		echo "Database volume $(DEV_DB_VOLUME) is already absent."; \
	fi
	$(MAKE) --no-print-directory up

rebuild:
	$(COMPOSE) build --no-cache

rebuild-dev: rebuild

config:
	$(COMPOSE) config --quiet

config-dev: config

# release/version.json is the only manually edited version source. To update
# generated copies, run: node .github/scripts/version-contract.mjs --write
version-check:
	node .github/scripts/version-contract.mjs --check

# Honest local/CI baseline using only gates that exist today. Coverage gate is
# report-only in verify (does not block PRs); release-check enforces thresholds.
# Secret scan (Gitleaks) and container scan (Trivy) are integrated in CI.
# Browser E2E remains a separate service-backed gate; AIQ RC requires the
# release provider credentials and is therefore executed by the RC workflow.
verify: version-check
	node --test .github/scripts/version-contract.test.mjs .github/scripts/release-manifest-contract.test.mjs .github/scripts/coverage-gate-lib.test.mjs .github/scripts/ci-workflow-contract.test.mjs
	node .github/scripts/verify-schema-mirror.mjs
	cd packages/shared && npm run typecheck && npm test
	cd packages/db && npm run typecheck && npm test
	cd packages/ai-quality && npm run typecheck && npm test && npm run pr-gate
	cd apps/api && npm run typecheck && npm test
	cd apps/web && npm run typecheck && npm run lint && npm test
	cd workers/ai-worker && npm run typecheck && npm test
	cd tests/e2e && npm run typecheck
	node .github/scripts/skip-todo-gate.mjs
	node .github/scripts/coverage-gate.mjs --report-only

# Coverage gate with threshold enforcement (blocks release-check, not PRs).
coverage-gate:
	node .github/scripts/coverage-gate.mjs

# Skip/todo allowlist gate (blocks verify and release-check).
skip-todo-gate:
	node .github/scripts/skip-todo-gate.mjs

# Generate release manifest (collects test summaries, coverage, digests).
release-manifest:
	node .github/scripts/release-manifest-generate.mjs

# Source inputs are checked first. The actual manifest is generated after the
# tag and stays untracked because embedding HEAD in a tracked file would be
# self-referential. On an exact release tag, the final command fails closed
# unless RELEASE_MANIFEST_PATH names a complete CI/release JSON artifact.
release-check:
	node .github/scripts/verify-release-inputs.mjs
	$(MAKE) --no-print-directory verify
	node .github/scripts/coverage-gate.mjs
	node .github/scripts/release-manifest-generate.mjs
	node .github/scripts/release-manifest-contract.mjs

shell-api:
	$(COMPOSE) exec api sh

shell-web:
	$(COMPOSE) exec web sh

shell-worker:
	$(COMPOSE) exec worker sh

# ─── Alpha environment (OPS-01) ──────────────────────────────────────
# Docker-based Alpha environment with Prometheus, Alertmanager, and
# backup infrastructure. Requires .env with POSTGRES_PASSWORD,
# MIGRATOR_PASSWORD, API_PASSWORD, WORKER_PASSWORD, MINIO_ROOT_PASSWORD.
ALPHA_SCRIPT := ./scripts/alpha-env-setup.sh

alpha-up:
	$(ALPHA_SCRIPT) up

alpha-down:
	$(ALPHA_SCRIPT) down

alpha-backup:
	$(ALPHA_SCRIPT) backup

alpha-restore-verify:
	$(ALPHA_SCRIPT) restore-verify

alpha-status:
	$(ALPHA_SCRIPT) status

alpha-metrics:
	$(ALPHA_SCRIPT) metrics
