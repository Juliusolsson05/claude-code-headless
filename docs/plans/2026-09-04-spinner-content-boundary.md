# Spinner cache correctness repair

Refs #53 and Agent Code #765. Continue PR #52 rather than ship its broad text
normalization and state-parser bypass unchanged.

1. Limit volatile substitutions to complete recognized status-line shapes;
   preserve composer/output/picker text, whitespace, and unknown formats.
2. Keep composer attribute and condition/grid extraction running on every
   emitted screen. A text-only cache cannot prove those inputs unchanged.
   Retain the expensive markdown snapshot reuse and bounded scrollback.
3. Add pure normalization and real headless-terminal regression tests for
   duration/token/remote-control edits alongside a genuine spinner tick.
4. Mirror normalization in Agent Code #761 and repair renderer attach replay;
   keep #778's package pin synchronized only with the reviewed revision.
5. Run package checks and host CI; no live provider or service interruption.
