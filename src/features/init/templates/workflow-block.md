<!-- ask-init:begin workflow v1 -->
## Ask workflow

This project uses the `@andares/pi-toolkits` ask workflow. The steps run in this order:

| step | entry | what it does |
| --- | --- | --- |
| discuss | `/ask` | read-only consult; `scratchpad` is the only write channel |
| plan | `/ask-plan <topic>` | research, ask questions, write `specs/<slug>.md`, review it block by block in the browser, implement only after approval |
| record | `record_change` | after the work: write the change record and one user-visible behaviour sentence |
| review | `/ask-review` | optional third-party model cross-check (check + fix); it leaves no state behind |
| accept | `/ask-uat` | cluster pending change records into acceptance items, verify them on the page, tick them off |

Rules that are easy to break:

- Change records live in `.agents/implementations/`; new ones carry the minute in the name (`YYYY-MM-DD_HHMM_slug.md`) and repeat it in the first line (`# YYYY-MM-DDTHH:MM±HH:MM — title`).
- The acceptance ledger is `.agents/uat/ledger.jsonl`, append-only, committed to git, and belongs to the main checkout. Never edit it by hand: the tools and the page write it.
- Acceptance items are created by clustering on the UAT side, never by an implementation session.
- Plans go in `specs/`, memory in `.agents/memory/`, evidence in `.agents/implementations/`.

<!-- ask-init:end workflow -->
