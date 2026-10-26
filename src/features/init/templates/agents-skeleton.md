# {{project}} — {{docTitle}}

{{contract}}

> Created {{date}} by `/ask-init` (agent-framework v{{frameworkVersion}}).
<!-- TODO(ask-init): remove this line after reviewing the guide. -->

## {{h_what}}

<!-- TODO(ask-init): one short paragraph: what this project is, who it serves, what it is not. Evidence only. -->

## {{h_rules}}

<!-- TODO(ask-init): numbered invariants. Each ≤2 lines; a rule that needs detail points at the file that owns it. Never invent a rule: derive it from a manifest, a script, a CI gate, or an explicit decision. -->

## {{h_commands}}

<!-- TODO(ask-init): copy-pasteable install / build / test / lint / run / release commands, read from manifests and CI. Mark anything unverified. -->

## {{h_layout}}

<!-- TODO(ask-init): top-level tree with one line per entry, including .agents/ and specs/. -->

## {{h_index}}

{{index}}

{{roots}}

## {{h_impact}}

<!-- TODO(ask-init): change → code location → what else must be updated in the same change. Start with the areas the survey actually found. -->

## {{h_terms}}

<!-- TODO(ask-init): only terms that get confused; the full glossary belongs in .agents/memory/TERMS.md. -->

## {{h_maintenance}}

- framework: agent-framework v{{frameworkVersion}} (`{{statePath}}`)
- budgets: AGENTS.md soft {{softBudget}} / hard {{hardBudget}} characters; one memory file {{memoryBudget}}
- audit: `/ask-init check`
- before writing memory: read `{{contractPath}}`
- records: one file per change in `{{implementationsDir}}/`, first line carries the exact time
