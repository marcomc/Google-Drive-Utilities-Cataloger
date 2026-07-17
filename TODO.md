# TODO

This backlog records concrete work that is intentionally not implemented in
release `0.1.0`. Completed work belongs in `CHANGELOG.md`, not here.

## Propositions

- [ ] **Automate adoption of an existing installation**
  - Assessment: the installer currently refuses `.clasp.json` without matching
    installer state because it cannot safely infer resource ownership.
  - Actions:
    - Define an auditable discovery contract for Apps Script, Cloud project,
      Drive, Sheet, Pub/Sub, triggers, and Script Properties.
    - Require explicit confirmation for every adopted resource.
    - Generate validated installer state without rotating credentials or
      recreating live resources.
    - Add adoption and conflict regression tests.

- [ ] **Add an explicit installed-project update and reconcile mode**
  - Assessment: resuming a completed installation retries local secret cleanup
    but does not deploy newer source or repair remote drift automatically.
  - Actions:
    - Compare the checkout, Apps Script deployment, triggers, Script
      Properties, Pub/Sub, and Workspace Events topology without changing them.
    - Separate read-only verification from explicitly approved source update
      and remote repair.
    - Preserve resource ownership checks and current private bootstrap
      boundaries.
    - Add completed-state drift, update, repair, and rollback tests.

- [ ] **Implement remote uninstall and teardown**
  - Assessment: `make install-reset` removes only private local state; remote
    cleanup remains manual to avoid destructive mistakes.
  - Actions:
    - Inventory installation-owned Cloud, Apps Script, Pub/Sub, Workspace
      Events, trigger, Secret Manager, Drive, and Sheet resources.
    - Separate reversible disablement from destructive deletion.
    - Require ownership verification and an explicit deletion plan.
    - Add dry-run output and teardown recovery documentation.

- [ ] **Build disposable Google integration tests**
  - Assessment: local tests and read-only preflight do not prove a fresh
    end-to-end Google installation or document-processing lifecycle.
  - Actions:
    - Provision an isolated test project, Drive folder, spreadsheet, and Apps
      Script instance.
    - Cover import, archive-only, duplicate, needs-review, retry, fallback,
      renaming, spreadsheet, email, and cleanup cases.
    - Record Gemini request counts and verify that unchanged files are not
      resubmitted.
    - Remove every generated test resource after the suite.

- [ ] **Add continuous integration**
  - Assessment: `make check` is local only, so publication currently depends on
    contributors running the complete gate themselves.
  - Actions:
    - Run ShellCheck, Markdownlint, Bash syntax, JavaScript syntax, and all test
      suites on pull requests.
    - Add repository secret and personal-data scanning.
    - Pin CI tool versions and cache only non-sensitive dependencies.
    - Document required branch-protection checks.

- [ ] **Lock the installer CLI dependency graph**
  - Assessment: the installer pins `clasp` to version `3.3.0`, but `npx`
    resolves its transitive dependency graph outside this repository.
  - Actions:
    - Add a minimal package manifest and lockfile for the installer toolchain.
    - Use the locked local binary after an integrity-checked installation.
    - Preserve the current preflight error and CLI-first remediation guidance.
    - Add a clean-clone reproducibility test.

- [ ] **Generate private configuration interactively**
  - Assessment: the installer creates `config.local.json`, but users must still
    edit suppliers, aliases, addresses, destinations, and sheet mappings
    manually.
  - Actions:
    - Add a guided configuration questionnaire with repeatable list entry.
    - Validate destination-template and sheet-mapping coverage before saving.
    - Provide a non-interactive structured-input equivalent.
    - Preserve direct expert editing of `config.local.json`.

- [ ] **Provision optional billing budgets and alerts**
  - Assessment: the installer links billing but does not create a budget or
    notification policy; Google Cloud budgets are alerts, not hard spending
    limits.
  - Actions:
    - Detect whether the operator can manage billing budgets.
    - Offer an opt-in monthly amount and alert thresholds.
    - Reuse or create a dedicated notification channel safely.
    - Explain that service quotas or manual billing controls are required for a
      hard stop.

- [ ] **Add runtime health alerts**
  - Assessment: structured logs exist, but trigger failures, expired event
    subscriptions, and repeated processing errors do not generate independent
    operational alerts.
  - Actions:
    - Define health signals for trigger age, subscription expiry, queue
      backlog, and repeated file failures.
    - Add low-noise alert policies and a periodic synthetic health check.
    - Keep document content, recipient addresses, and credentials out of alert
      payloads.
    - Document acknowledgement and recovery procedures.

- [ ] **Support installer state migrations**
  - Assessment: installer state is versioned, but an unknown version currently
    fails closed instead of migrating.
  - Actions:
    - Define forward-only migrations between installer-state versions.
    - Back up private state before applying a migration.
    - Validate resource ownership again after migration.
    - Add fixtures for supported, corrupt, and future state versions.

- [ ] **Validate shared-drive installations end to end**
  - Assessment: documented permissions account for shared drives, but the
    create, move, event, and spreadsheet paths lack automated shared-drive
    coverage.
  - Actions:
    - Test Content manager and Manager roles separately.
    - Verify spreadsheet creation and movement into a shared drive.
    - Validate Workspace Events delivery and direct-root filtering.
    - Document unsupported organization-policy combinations.

- [ ] **Publish release 0.1.0 after human review**
  - Assessment: release content is documented, but repository publication,
    tagging, and release creation remain intentionally user-controlled.
  - Actions:
    - Review the complete diff and publication privacy scan.
    - Confirm repository metadata, default branch, and CI requirements.
    - Commit and tag `v0.1.0` only after explicit approval.
    - Publish release notes derived from `CHANGELOG.md`.
