# Kora workflow protocol

The outer repository's `contracts/workflow/schemas/` directory is the normative
language-neutral workflow wire contract as of the Phase 12.2-B authority flip.
Those reviewed files are source and are never emitted by a language generator.
Python runtime adapters, product-UI types, packaged schemas, and KoraCode
contract copies are derived from them; a copy of this README does not transfer
schema authority to the package containing that copy.
`workflows/backend/contracts/export.py --check` rejects generated drift.

Version `v1` uses JSON Schema Draft 2020-12 and RFC 8785 canonical bytes. A
digest is lowercase `sha256:` plus the SHA-256 hex digest of those bytes.
Lifecycle status and `outcome_label` are intentionally independent.

Compatibility policy is in `compatibility.json`; the complete current field
inventory and known mirror differences are in `INVENTORY.md` and
`MISMATCHES.md`. Fixtures under `fixtures/` are consumed unchanged by Python,
the product UI, and KoraCode. Python remains the only execution engine during
this flip.
