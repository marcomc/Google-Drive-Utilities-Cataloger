SHELL := /bin/bash

INSTALLER := ./scripts/install.sh
MARKDOWNLINT ?= markdownlint
MARKDOWNLINT_CONFIG ?= .markdownlint.json
SHELLCHECK ?= shellcheck

MARKDOWN_FILES := $(sort $(wildcard *.md docs/*.md))
SHELL_FILES := $(sort $(wildcard scripts/*.sh scripts/*/*.sh tests/*.sh))

.DEFAULT_GOAL := help
.NOTPARALLEL: install install-resume install-debug install-resume-debug install-reset

.PHONY: help install install-resume install-check install-debug
.PHONY: install-resume-debug install-reset test lint lint-shell lint-md
.PHONY: lint-json check

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\nTargets:\n"} \
		/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)

install: ## Start or continue the interactive installer
	@$(INSTALLER)

install-resume: ## Resume after the one-time browser handoff
	@$(INSTALLER) --resume

install-check: ## Check local tools and Google account access
	@$(INSTALLER) --check

install-debug: ## Start the installer with diagnostic output
	@$(INSTALLER) --debug

install-resume-debug: ## Resume with diagnostic output
	@$(INSTALLER) --resume --debug

install-reset: ## Remove local installer state, preserving Google resources
	@$(INSTALLER) --reset

test: ## Run installer helper and Apps Script tests
	@./tests/install_test.sh
	@node --check scripts/list-locales.js
	@node --check scripts/validate-config.js
	@node --check scripts/validate-apps-script.js
	@node --check tests/apps_script_installer_test.js
	@node --check tests/drive_events_transport_test.js
	@node --check tests/project_contract_test.js
	@node --check tests/utilities_cataloging_test.js
	@node scripts/validate-apps-script.js
	@node scripts/list-locales.js >/dev/null
	@node tests/apps_script_installer_test.js
	@node tests/drive_events_transport_test.js
	@node tests/project_contract_test.js
	@node tests/utilities_cataloging_test.js

lint-shell: ## Lint all shell scripts
	@$(SHELLCHECK) --enable=all $(SHELL_FILES)

lint-md: ## Lint project Markdown
	@$(MARKDOWNLINT) --config $(MARKDOWNLINT_CONFIG) $(MARKDOWN_FILES)

lint-json: ## Validate committed JSON files
	@jq empty appsscript.json config.example.json

lint: lint-shell lint-md lint-json ## Run all linters

check: lint test ## Run all static validation and tests
