# Resolved characterization mismatch report

- Python Pydantic models and the React builder previously mirrored fields by
  hand. `output_binding` and edge `outcome_role` were missing from the canvas
  round trip; Phase 10.8 now preserves both.
- Python accepted JSON-Schema-shaped dictionaries without meta-validation;
  runtime contract validation now applies Draft 2020-12, bounded local refs,
  object roots where required, and value-free errors.
- `AgentNode.model`, `capabilities`, and `input_schema` were stored but ignored.
  They now drive alias resolution, the reviewed tool registry, and narrowing.
- Script/loop values were coerced to strings. The typed execution context now
  preserves JSON values while legacy prompt placeholders serialize them.
- The browser-local walker supported only linear agent graphs but could receive
  advanced fields. It now refuses all advanced features when the durable
  backend is unavailable.
- JSON Schema alone does not express every graph topology and event-order rule.
  Both language readers therefore run schema validation plus the shared
  semantic fixture corpus.
- Phase 12.2-B removed the editable UI wire mirror. The Python domain model is
  retained only as an execution adapter and is checked against the normative
  schema; changing it independently fails conformance.
