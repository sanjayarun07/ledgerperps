# Perps top-level Makefile.  LOCAL DEV ONLY.  UNAUDITED prototype.
COMPOSE := docker compose -f infra/docker-compose.yml
.PHONY: help up down test abi bench doctor logs clean

help:
	@echo "make up      install deps, compile, start chain + deploy + seed + monitoring, start services that exist"
	@echo "make down    stop the stack (keeps volumes); 'make clean' also removes volumes"
	@echo "make test    contracts: hardhat tests (+ forge tests if foundry.toml and *.t.sol exist)"
	@echo "make abi     export merged ABI to contracts/abi/"
	@echo "make bench   real gas benchmark (in-process hardhat) -> infra/bench/last-run.json"

doctor:
	@command -v docker >/dev/null || { echo "MISSING: docker"; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "docker daemon NOT running: start Docker Desktop. Validating compose file only:"; $(COMPOSE) --profile services --profile bus config -q && echo "compose config valid"; exit 1; }
	@echo "docker daemon OK"

up: doctor
	@echo "==> [1/5] contract deps"
	@cd contracts && { [ -d node_modules/hardhat ] || pnpm install --frozen-lockfile || pnpm install; }
	@echo "==> [2/5] compile"
	@cd contracts && npx hardhat compile
	@echo "==> [3/5] chain + deployer (deploy, export ABI, seed 10 accounts) + postgres/redis/prometheus/grafana"
	@$(COMPOSE) up -d --build chain chain-exporter postgres redis prometheus grafana
	@$(COMPOSE) up --build --exit-code-from deployer deployer
	@echo "==> [4/5] optional services (started only if their source has a manifest)"
	@SVC=""; MISSING=""; \
	 for s in keeper:services/keeper/Cargo.toml indexer:services/indexer/Cargo.toml frontend:frontend/package.json bots:bots/package.json bots:bots/Cargo.toml; do \
	   n=$${s%%:*}; f=$${s#*:}; \
	   if [ -f $$f ]; then case " $$SVC " in *" $$n "*) ;; *) SVC="$$SVC $$n";; esac; fi; done; \
	 for n in keeper indexer frontend bots; do case " $$SVC " in *" $$n "*) ;; *) MISSING="$$MISSING $$n";; esac; done; \
	 if [ -n "$$SVC" ]; then echo "starting:$$SVC (Dockerfile templates in infra/docker are UNTESTED; failure here is non-fatal)"; $(COMPOSE) up -d --build $$SVC || echo "WARN: some services failed to build/start (see above)"; fi; \
	 if [ -n "$$MISSING" ]; then echo "NOT PRESENT (no manifest found, skipped):$$MISSING"; fi; true
	@echo "==> [5/5] done"
	@echo "  RPC http://localhost:8545 | deployment: contracts/deployments/localhost.json | Prometheus :9090 | Grafana http://localhost:3001 (admin/admin_dev_only)"

down:
	@$(COMPOSE) --profile services --profile bus down

clean:
	@$(COMPOSE) --profile services --profile bus down -v

logs:
	@$(COMPOSE) logs -f --tail=100

test:
	@echo "==> hardhat tests"
	@cd contracts && { [ -d node_modules/hardhat ] || pnpm install --frozen-lockfile; } && npx hardhat test
	@if [ -f contracts/foundry.toml ] && ls contracts/test/*.t.sol >/dev/null 2>&1; then echo "==> forge tests"; cd contracts && forge test; else echo "==> forge: no foundry.toml / *.t.sol in contracts/, skipped"; fi

abi:
	@cd contracts && npx hardhat run scripts/export-abi.js

bench:
	@cd contracts && npx hardhat run ../infra/bench/gas-bench.js
