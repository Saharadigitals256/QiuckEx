# ADR-NNNN: Short imperative title

<!--
Copy this file to docs/adr/NNNN-kebab-case-title.md, replace NNNN with the next
free sequence number, and keep the section headings/order exactly as-is: the
governance gate (scripts/governance/check.mjs) fails the build otherwise.
Delete these instructions before opening the PR.
-->

## Status

Accepted <!-- Proposed | Accepted | Rejected | Deprecated | Superseded by ADR-NNNN -->

## Context

What forced a decision, what constraints exist (network, custody, compliance,
client compatibility), and what evidence supports them. Link the owning module
and any measurement, issue, or incident.

## Decision

The decision in one or two sentences, then the specific rules, invariants and
defaults it establishes. Name the owning module paths and config keys.

## Consequences

What becomes easier, what becomes harder, and what contributors must do
differently. Include the failure and degraded-mode behaviour this commits us to.

## Reversal Cost

How expensive reversal is (LOW / MEDIUM / HIGH / IRREVERSIBLE), who can reverse
it, and the exact procedure if one exists.

## Invariants Affected

Link the invariants from [../INVARIANTS.md](../INVARIANTS.md) that this decision
protects or constrains. Write `None` if the decision is not financial or
state-machine related.

## References

- Owning code paths
- Related ADRs, policies, specs and external documentation
