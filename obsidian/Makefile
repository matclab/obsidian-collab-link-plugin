# Build, check and install the Collab Link plugin (obsidian/README.md).
#   make build
#   make install VAULT_PATH=~/Notes
SHELL=bash

.DEFAULT_GOAL := help
.PHONY: help deps build check test lint types e2e check-ui install uninstall clean

# The vault to install into: the folder that holds .obsidian/. VAULT works
# too (make install VAULT=~/Notes).
VAULT_PATH ?= $(VAULT)
# Where a relative VAULT_PATH is read from: here, or the root's Makefile's
# folder when it delegates (make obsidian-install VAULT_PATH=…).
ORIGIN_DIR ?= $(CURDIR)
PLUGIN_ID := collab-link
# The vault's folder in bash: quoted (a vault's name often has spaces), a
# leading ~ the home folder even when the shell left it (zsh does), a
# relative path read from ORIGIN_DIR.
with_vault = vault="$(VAULT_PATH)"; vault="$${vault/\#\~/$$HOME}"; vault="$${vault%/}"; \
	case "$$vault" in ""|/*) ;; *) vault="$(ORIGIN_DIR)/$$vault" ;; esac; \
	if [ -z "$$vault" ]; then echo "Set VAULT_PATH to the vault's folder: make $@ VAULT_PATH=~/Notes" >&2; exit 1; fi; \
	plugin="$$vault/.obsidian/plugins/$(PLUGIN_ID)"
DIST := dist/main.js dist/manifest.json dist/styles.css

# What the build reads: the plugin, and the page and library it bundles.
SOURCES := $(shell find src ../web/src ../web/lib/src \( -name "*.ts" -o -name "*.svelte" -o -name "*.css" \) -not -name "*.test.ts") \
	build.mjs manifest.json

help: ### Print this help message
	@grep -h -E '^[^ :]+:.*?## .*$$' $(MAKEFILE_LIST) \
	| sed -n 's/^\(.*\):\(.*\)##\(.*\)/\1▅\3/p' \
	| column -t  -s '▅'

# The dependencies are web/'s: node_modules is a link to them (decision 12).
# Installed when missing only: after a change of web/package-lock.json,
# run `npm ci` in web/ yourself.
../web/node_modules:
	cd ../web && npm ci

node_modules: | ../web/node_modules
	ln -s ../web/node_modules node_modules

deps: node_modules ## Install the dependencies (web/'s, linked)

$(DIST) &: $(SOURCES) | node_modules
	npm run build

build: $(DIST) ## Build the plugin into dist/ (main.js, manifest.json, styles.css)

types: | node_modules ## Type-check the plugin
	npx tsc --noEmit

lint: | node_modules ## Lint the plugin (Biome)
	npm run lint

test: | node_modules ## Run the unit tests (vitest, Obsidian faked)
	npm test

check: types lint test ## Types, lint and unit tests, as ./ci.sh does

../server/target/debug/server:
	cd ../server && cargo build -p app

e2e: | node_modules ../server/target/debug/server ## End to end in the real Obsidian (Xvfb) against the real server
	npm run test:e2e

check-ui: | node_modules ../server/target/debug/server ## axe-core and screenshots of the view in the real Obsidian
	npm run check:ui

install: build ## Install into a vault: make install VAULT_PATH=<vault>
	@$(with_vault); \
	if [ ! -d "$$vault/.obsidian" ]; then echo "$$vault is not an Obsidian vault (no .obsidian/ in it)" >&2; exit 1; fi; \
	install -d "$$plugin" && install -m 0644 $(DIST) "$$plugin/" && \
	echo "Installed in $$plugin: reload Obsidian, or turn Collab Link off and on, then enable it in Community plugins."

uninstall: ## Remove the plugin's files from a vault (its data.json is kept)
	@$(with_vault); \
	rm -f "$$plugin/main.js" "$$plugin/manifest.json" "$$plugin/styles.css" && \
	echo "Removed from $$plugin"

clean: ## Remove dist/
	rm -rf dist
