# Skill Quality Checklist

Use this checklist before finalizing a Skill to ensure it meets quality standards.

## Core Quality

### Metadata

- [ ] **Name follows conventions**
  - Lowercase letters, numbers, hyphens only
  - Maximum 64 characters
  - Matches directory name
  - Uses gerund form (verb + -ing): `processing-pdfs`, `analyzing-data`
  - No reserved words: "anthropic", "claude"
  - No XML tags

- [ ] **Description is effective**
  - Maximum 1024 characters
  - Answers "what does it do?"
  - Answers "when to use it?"
  - Includes specific trigger keywords users would naturally say
  - Written in third person: "Processes Excel files" not "I can help"
  - No XML tags
  - No vague terms like "helps with documents"

### Structure and Organization

- [ ] **SKILL.md body under 500 lines**
  - If exceeding, split content into referenced files
  - Keep essential info in SKILL.md
  - Move details to separate files

- [ ] **File references are one level deep**
  - All reference files linked directly from SKILL.md
  - No nested references (A → B → C)
  - For files >100 lines, table of contents included at top

- [ ] **All file paths use forward slashes**
  - `scripts/helper.py` ✓
  - `scripts\helper.py` ✗
  - Works across all platforms

- [ ] **Progressive disclosure used appropriately**
  - Quick start / essential info in SKILL.md
  - Detailed docs in referenced files
  - Utility scripts in scripts/ directory
  - Clear navigation from SKILL.md to resources

### Content Quality

- [ ] **No time-sensitive information**
  - Or deprecated content in "old patterns" section with `<details>` tags
  - Example: Don't say "before August 2025, use old API"
  - Instead: Use current method, document old patterns separately

- [ ] **Consistent terminology throughout**
  - One term per concept
  - "API endpoint" not mixing with "URL", "route", "path"
  - "field" not mixing with "box", "element", "control"

- [ ] **Examples are concrete, not abstract**
  - Show actual code/text, not placeholders
  - Input/output pairs when helpful
  - Real scenarios, not hypothetical

---

## Instructions Quality

### Conciseness

- [ ] **Only includes context Claude doesn't already have**
  - Challenge each piece: "Does Claude really need this?"
  - No explanations of common concepts (what PDFs are, how libraries work)
  - Assume Claude is already very smart

- [ ] **No unnecessary explanations**
  - Brief for simple operations
  - Detailed only for complex/non-obvious logic
  - No verbose introductions

### Clarity

- [ ] **Appropriate degree of freedom**
  - **High freedom**: Multiple approaches valid, heuristics guide
  - **Medium freedom**: Preferred pattern exists, some variation OK
  - **Low freedom**: Operations fragile, exact instructions needed
  - Choice matches task fragility

- [ ] **Clear workflows for complex tasks**
  - Multi-step processes have numbered steps
  - Progress checklist provided for tracking
  - Each step clearly explained
  - Decision points marked

- [ ] **Feedback loops for quality-critical operations**
  - Validation steps included
  - "Run validator → fix errors → repeat" pattern
  - Clear success criteria
  - Instructions for handling failures

---

## Code and Scripts (if applicable)

### Script Quality

- [ ] **Scripts solve problems rather than punt to Claude**
  - Handle error conditions explicitly
  - Don't just fail and let Claude figure it out
  - Provide meaningful error messages
  - Offer alternatives when possible

- [ ] **Error handling is explicit and helpful**
  - Try/except blocks with specific handling
  - Clear error messages pointing to solution
  - Graceful degradation when possible

- [ ] **No "voodoo constants" (all values justified)**
  - Magic numbers explained with comments
  - Configuration parameters documented
  - "Why this value?" clearly answered

Example:
```python
# HTTP requests typically complete within 30 seconds
# Longer timeout accounts for slow connections
REQUEST_TIMEOUT = 30

# Three retries balances reliability vs speed
# Most intermittent failures resolve by second retry
MAX_RETRIES = 3
```

- [ ] **Required packages listed and verified**
  - All dependencies documented in SKILL.md
  - Packages available in Claude Code environment
  - Installation instructions provided

- [ ] **Scripts have clear documentation**
  - Purpose explained
  - Input/output format specified
  - Usage examples provided
  - Edge cases noted

### Utility Script Usage

- [ ] **Execution intent is clear**
  - "Run `script.py` to extract fields" (execute)
  - "See `script.py` for extraction algorithm" (read as reference)
  - Clear distinction made in instructions

- [ ] **Validation/verification steps for critical operations**
  - Scripts verify inputs before processing
  - Outputs validated before finalizing
  - Checkpoints in multi-step workflows

---

## Testing

### Coverage

- [ ] **At least three evaluation scenarios created**
  - Representative of real usage
  - Cover main use cases
  - Include edge cases
  - Document expected behavior

- [ ] **Tested with all target models**
  - Haiku (if applicable)
  - Sonnet (if applicable)
  - Opus (if applicable)
  - Instructions work across all targets

- [ ] **Tested with real usage scenarios**
  - Not just hypothetical examples
  - Actual tasks users would perform
  - Multiple variations of requests
  - Different phrasings that should trigger Skill

### Observation

- [ ] **Skill triggers when expected**
  - Description matches user requests
  - Trigger keywords effective
  - No false negatives (should trigger but doesn't)
  - No false positives (triggers when shouldn't)

- [ ] **Claude follows workflow correctly**
  - Doesn't skip steps
  - Validates at checkpoints
  - Handles errors appropriately
  - Uses feedback loops

- [ ] **Claude finds right information**
  - Navigates to correct reference files
  - Doesn't get lost in structure
  - Reads appropriate level of detail
  - Doesn't overload context with unnecessary files

- [ ] **Team feedback incorporated (if applicable)**
  - Others have used the Skill
  - Feedback documented and addressed
  - Edge cases discovered and handled

---

## Advanced Considerations (if applicable)

### Tool Restrictions

- [ ] **`allowed-tools` used appropriately**
  - Restricts to necessary tools only
  - Read-only Skills limit to Read, Grep, Glob
  - Security-sensitive workflows restrict capabilities
  - Omitted if no restrictions needed

### Forked Context

- [ ] **`context: fork` justified**
  - Complex multi-step operation benefits from isolation
  - Main conversation shouldn't be cluttered
  - Appropriate agent type specified with `agent:` field

### MCP Integration

- [ ] **MCP tools use fully qualified names**
  - Format: `ServerName:tool_name`
  - Example: `BigQuery:bigquery_schema`
  - Not just tool name alone

### Hooks

- [ ] **Hooks scoped appropriately**
  - Defined in Skill frontmatter if Skill-specific
  - Cleanup handled automatically
  - `once: true` used when appropriate

---

## Distribution Readiness

### Documentation

- [ ] **README or usage guide included (if distributing)**
  - Purpose clearly explained
  - Installation instructions (if needed)
  - Quick start example
  - Troubleshooting section

- [ ] **Dependencies clearly documented**
  - External packages listed
  - Version requirements specified
  - Installation commands provided

### Compatibility

- [ ] **Works in target environment**
  - Personal Skills: `~/.claude/skills/`
  - Project Skills: `.claude/skills/`
  - Plugin: `skills/` in plugin directory
  - Tested in actual deployment location

- [ ] **File paths correct for distribution method**
  - Relative paths used appropriately
  - No hardcoded absolute paths
  - Platform-independent (forward slashes)

---

## Final Review Questions

Before marking the Skill as complete, ask yourself:

1. **Does this Skill solve a real problem?**
   - Based on actual need, not hypothetical?
   - Would I use this regularly?

2. **Is the description clear enough for discovery?**
   - Would a user's natural request trigger this?
   - Are trigger keywords obvious?

3. **Is the Skill as simple as possible?**
   - Any unnecessary complexity removed?
   - Instructions as concise as possible?

4. **Have I tested it in real scenarios?**
   - Not just examples, but actual usage?
   - With different models if applicable?

5. **Would someone else understand this Skill?**
   - Clear without needing me to explain?
   - Examples are concrete and helpful?

6. **Is the code reliable?**
   - Error handling comprehensive?
   - Edge cases covered?

7. **Am I following best practices?**
   - Progressive disclosure if needed?
   - Feedback loops where appropriate?
   - Patterns used correctly?

---

## Quick Reference: Common Issues

| Issue | Solution |
|-------|----------|
| Skill doesn't trigger | Improve description with trigger keywords |
| Claude skips steps | Make workflow more explicit, add checklist |
| Claude reads wrong files | Reorganize structure, make links more prominent |
| SKILL.md too long | Split into referenced files, use progressive disclosure |
| Scripts fail often | Add error handling, validation steps |
| Inconsistent behavior | Test with all target models, adjust instructions |
| Hard to maintain | Simplify structure, remove unnecessary complexity |
| Team doesn't use it | Gather feedback, improve description and usability |

---

## Checklist Summary

Quick check - all critical items covered:

- [ ] Name and description follow requirements
- [ ] SKILL.md under 500 lines
- [ ] No time-sensitive information
- [ ] Consistent terminology
- [ ] Concise instructions (only new context)
- [ ] Appropriate degree of freedom
- [ ] Forward slashes in all paths
- [ ] Scripts handle errors (no punting)
- [ ] Tested with representative scenarios
- [ ] Tested with all target models

If all checked, your Skill is ready for use or distribution!
