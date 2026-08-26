# 0004 — Secret references, never secret values

> **Superseded by compatible-upstream v1 (TOG-530/TOG-532).** This record is retained as historical context only; its deployment-specific policy is not active product behavior.


- Status: accepted
- Date: 2026-08-23

## Context

The plugin needs the teamclaude API key to read pooled-quota status. This
repository is the artifact that outlives the epic, so a credential committed
here — or pasted into a company's stored config — is a permanent problem.

Paperclip provides `format: "secret-ref"` on a config field plus
`ctx.secrets.resolve()`, which resolves a `{ type: "secret_ref", secretId,
version }` binding at call time.

## Decision

`quotaGate.apiKeySecretRef` is declared with `format: "secret-ref"` and a type of
`["object", "null"]`. The key is resolved through `ctx.secrets.resolve()` at the
moment it is used and is never cached, logged, or written to plugin state.

The object type is deliberate. Ajv then **rejects a raw string** at that field,
so a pasted key cannot be stored in a company's config even by mistake. This is
a stronger guarantee than a convention, and `tests/config.spec.ts` asserts it.

## Consequences

- Ajv logs a benign `strictTypes` note — "missing type number,string for keyword
  format" — because the host registers `secret-ref` as a string format while this
  field is an object. Validation is unaffected: null and the binding object are
  accepted, a raw string is rejected. The note appears in host logs too and is
  expected. Our own tests construct Ajv with `logger: false` for that reason and
  are otherwise identical to the host's construction.
- If the quota key is missing or wrong, the gate reports the failure and leaves
  itself open rather than pausing every company's Claude work. An unreadable
  status endpoint is not evidence that quota is exhausted.
- CI runs gitleaks with repository-specific rules for teamclaude and OmniRoute
  credential shapes, and `tests/manifest.spec.ts` scans the committed sources for
  credential-shaped literals.
