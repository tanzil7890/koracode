# v1 contract inventory

The characterized execution definition includes graph version/name/entry,
settings, workflow input schema, variables, all seven node kinds, positions,
model aliases, capability names, input narrowing schemas and `x-source`,
screen policy, scripts, hardening captures, output schema/binding, all edge
kinds, failure latching, selectors, labels, and transition payload schemas.

The execution surface includes recursive definition members and asset digests;
run lifecycle and immutable terminal outcome labels; typed result/output;
authoring, run-attempt, and run-global event envelopes; structured failures;
and artifact manifests. Runtime-only provenance includes protocol, engine and
engine version, definition/plan digest, model/capability registry digests, and
policy digest.

The neutral JSON Schemas are the 12.2-B wire source. Python Pydantic classes
are runtime adapters that validate their normalized output against the
packaged schema; the product UI and KoraCode import generated types. Semantic
conformance additionally runs graph topology, bounded nested-schema,
capability dependency, canonicalization, and event-order validators.
