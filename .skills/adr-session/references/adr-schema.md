# ADR Frontmatter Schema

## Frontmatter Fields

```yaml
---
status: Proposed | Accepted | InProgress | Complete
deps:
  - NNN  # ADR number this depends on
plan: plan-{slug}.md  # relative path from docs/plans/
substatus: investigating | blocked  # optional free-text
---
```

### Required Fields

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `status` | string | `Proposed`, `Accepted`, `InProgress`, `Complete` | Current lifecycle state |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `deps` | number[] | ADR numbers this depends on |
| `plan` | string | Plan filename (e.g., `plan-auth-system.md`) |
| `substatus` | string | Free-text sub-state (e.g., `investigating`, `blocked`) |

## Status Lifecycle

```
Proposed → Accepted → InProgress → Complete
   ↑                      │
   └──────────────────────┘ (revert if plan invalidated)
```

| Status | Meaning |
|--------|---------|
| `Proposed` | Initial draft, under investigation |
| `Accepted` | Investigation complete, decision validated by logic-validator |
| `InProgress` | Plan created, implementation underway |
| `Complete` | Implementation finished, verified |

## Phase Determination Logic

Phase is derived from status + plan existence + validation state:

```
if status == Complete           → phase: done
if status == Proposed           → phase: investigation
if status == Accepted:
  if no plan                    → phase: planning
  if plan exists:
    if plan has <!-- validated --> → phase: implementation
    else                        → phase: validation
if status == InProgress         → phase: implementation
```

| Phase | Status | Plan | Validated | Recommended Action |
|-------|--------|------|-----------|--------------------|
| `investigation` | Proposed | - | - | Research, fill ADR content, validate with logic-validator |
| `planning` | Accepted | none | - | Create plan in `docs/plans/`, enter Plan Mode |
| `validation` | Accepted | exists | no | Run `/validate-plan` to add `<!-- validated -->` |
| `implementation` | Accepted/InProgress | exists | yes | Follow plan, use `/execute-plan` or `/decompose` |
| `done` | Complete | - | - | No action needed |

## Actionable ADR Determination

An ADR is **actionable** when ALL conditions are met:

1. `status` is NOT `Complete`
2. All `deps` (if any) reference ADRs with `status: Complete`
3. The ADR is not involved in a circular dependency

### Circular Dependency Detection

When scanning deps, build a directed graph and detect cycles:

- If ADR-1 deps [2] and ADR-2 deps [1] → circular dependency warning
- List all ADR numbers involved in the cycle
- These ADRs are NOT actionable until the cycle is manually resolved

## File Naming Conventions

### ADR Files

```
docs/decisions/adr-NNN-{slug}.md
```

- `NNN`: Zero-padded 3-digit number (e.g., `001`, `012`)
- `{slug}`: Kebab-case title (e.g., `auth-system`, `api-design`)

### Plan Files

```
docs/plans/plan-{slug}.md
```

- `{slug}` should match the corresponding ADR slug

## Cross-Reference Conventions

### ADR → Plan Link

In ADR body:

```markdown
## 実装計画
[実装計画](../plans/plan-{slug}.md)
```

### Plan → ADR Link

In Plan header:

```markdown
関連 ADR: [ADR-NNN](../decisions/adr-NNN-{slug}.md)
```

### Plan Validation Marker

Added by `/validate-plan` or logic-validator at the end of the plan file:

```markdown
<!-- validated -->
```

This marker is NOT included in the plan template. It is added only after successful validation.

## Error Handling

### YAML Parse Errors

If frontmatter cannot be parsed as valid YAML:

- Display warning with filename and error details
- Skip the file in status overview
- Do not halt the entire scan

### Invalid Status Values

If `status` is not one of `Proposed | Accepted | InProgress | Complete`:

- Display warning with filename and the invalid value
- Skip the file in status overview

### Missing Frontmatter

Files without YAML frontmatter (`---` delimiters):

- In `/adr-session`: Report as "no frontmatter" in overview
- In `/adr-migrate`: Candidate for migration

## Workflow Summary

```
Session A: Investigation
  1. /adr-session new → Create ADR (status: Proposed)
  2. Research and fill ADR content
  3. logic-validator → Validate ADR logical consistency
  4. Update status: Proposed → Accepted

Session B: Planning
  1. /adr-session NNN → See phase guidance
  2. Create plan (Plan Mode or manually)
  3. /validate-plan → logic-validator validates plan
  4. <!-- validated --> marker added to plan
  5. Update status: Accepted → InProgress (optional, auto-detected by phase logic)

Session C: Implementation
  1. /adr-session NNN → See implementation guidance
  2. Follow plan steps (/execute-plan, /decompose)
  3. Verify tests pass
  4. Update status → Complete
```
