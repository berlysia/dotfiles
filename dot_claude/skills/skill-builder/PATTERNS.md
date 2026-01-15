# Common Skill Patterns

This document provides detailed examples of common patterns for building effective Skills.

## Contents

- Template Pattern - Provide output format templates
- Examples Pattern - Show input/output pairs for clarity
- Workflow Pattern - Guide through multi-step processes
- Conditional Workflow Pattern - Guide through decision points
- Progressive Disclosure Pattern - Organize content for on-demand loading
- Feedback Loop Pattern - Implement validation and iteration cycles
- Domain Organization Pattern - Organize content by functional domain

---

## Template Pattern

Provide templates for consistent output. Match strictness to your needs.

### Strict Template (for API responses, data formats)

````markdown
## Report structure

ALWAYS use this exact template structure:

```markdown
# [Analysis Title]

## Executive Summary
[One-paragraph overview of key findings]

## Key Findings
- Finding 1 with supporting data
- Finding 2 with supporting data
- Finding 3 with supporting data

## Recommendations
1. Specific actionable recommendation
2. Specific actionable recommendation
```

Do not deviate from this format.
````

### Flexible Template (when adaptation is useful)

````markdown
## Report structure

Here is a sensible default format, but adapt based on the analysis:

```markdown
# [Analysis Title]

## Executive Summary
[Overview]

## Key Findings
[Adapt sections based on what you discover]

## Recommendations
[Tailor to the specific context]
```

Adjust sections as needed for the specific analysis type.
````

**When to use:**
- Strict: API responses, structured data, compliance requirements
- Flexible: Creative content, context-dependent outputs

---

## Examples Pattern

Provide input/output pairs to clarify expected style and format.

### Commit Message Examples

````markdown
## Commit message format

Generate commit messages following these examples:

**Example 1: New feature**
Input: Added user authentication with JWT tokens
Output:
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

**Example 2: Bug fix**
Input: Fixed bug where dates displayed incorrectly in reports
Output:
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

**Example 3: Maintenance**
Input: Updated dependencies and refactored error handling
Output:
```
chore: update dependencies and refactor error handling

- Upgrade lodash to 4.17.21
- Standardize error response format across endpoints
```

Follow this style: type(scope): brief description, then detailed explanation.
````

### Code Style Examples

````markdown
## Function documentation style

Document functions following these examples:

**Example 1: Simple function**
```python
def calculate_total(items: list[float]) -> float:
    """Calculate sum of item prices."""
    return sum(items)
```

**Example 2: Complex function**
```python
def process_payment(
    amount: float,
    currency: str,
    metadata: dict
) -> PaymentResult:
    """Process payment transaction.

    Validates amount, applies currency conversion if needed,
    and records transaction in payment gateway.

    Raises ValueError if amount <= 0 or currency unsupported.
    """
    ...
```

Use brief docstrings for simple functions, detailed for complex logic.
````

**When to use:**
- Output quality depends on seeing examples
- Style consistency is important
- Format has nuanced conventions

---

## Workflow Pattern

Break complex operations into clear, sequential steps with progress tracking.

### Research Workflow (non-code)

````markdown
## Research synthesis workflow

Copy this checklist and track your progress:

```
Research Progress:
- [ ] Step 1: Read all source documents
- [ ] Step 2: Identify key themes
- [ ] Step 3: Cross-reference claims
- [ ] Step 4: Create structured summary
- [ ] Step 5: Verify citations
```

**Step 1: Read all source documents**

Review each document in the `sources/` directory. Note the main arguments and supporting evidence.

**Step 2: Identify key themes**

Look for patterns across sources. What themes appear repeatedly? Where do sources agree or disagree?

**Step 3: Cross-reference claims**

For each major claim, verify it appears in the source material. Note which source supports each point.

**Step 4: Create structured summary**

Organize findings by theme. Include:
- Main claim
- Supporting evidence from sources
- Conflicting viewpoints (if any)

**Step 5: Verify citations**

Check that every claim references the correct source document. If citations are incomplete, return to Step 3.
````

### PDF Form Filling Workflow (with code)

````markdown
## PDF form filling workflow

Copy this checklist and check off items as you complete them:

```
Task Progress:
- [ ] Step 1: Analyze the form (run analyze_form.py)
- [ ] Step 2: Create field mapping (edit fields.json)
- [ ] Step 3: Validate mapping (run validate_fields.py)
- [ ] Step 4: Fill the form (run fill_form.py)
- [ ] Step 5: Verify output (run verify_output.py)
```

**Step 1: Analyze the form**

Run: `python scripts/analyze_form.py input.pdf`

This extracts form fields and their locations, saving to `fields.json`.

**Step 2: Create field mapping**

Edit `fields.json` to add values for each field.

**Step 3: Validate mapping**

Run: `python scripts/validate_fields.py fields.json`

Fix any validation errors before continuing.

**Step 4: Fill the form**

Run: `python scripts/fill_form.py input.pdf fields.json output.pdf`

**Step 5: Verify output**

Run: `python scripts/verify_output.py output.pdf`

If verification fails, return to Step 2.
````

**When to use:**
- Multi-step processes where order matters
- Operations with validation checkpoints
- Complex tasks users might lose track of

---

## Conditional Workflow Pattern

Guide Claude through decision points to choose the right approach.

### Document Modification

```markdown
## Document modification workflow

1. Determine the modification type:

   **Creating new content?** → Follow "Creation workflow" below
   **Editing existing content?** → Follow "Editing workflow" below

2. Creation workflow:
   - Use docx-js library
   - Build document from scratch
   - Export to .docx format

3. Editing workflow:
   - Unpack existing document
   - Modify XML directly
   - Validate after each change
   - Repack when complete
```

### Data Processing

```markdown
## Data processing workflow

1. Identify data format:

   **Structured data (CSV, JSON)?** → Use pandas workflow
   **Unstructured text?** → Use NLP workflow
   **Binary files?** → Use specialized tools

2. Pandas workflow:
   ```python
   import pandas as pd
   df = pd.read_csv("data.csv")
   # Process with pandas operations
   ```

3. NLP workflow:
   ```python
   # Extract text
   # Apply NLP techniques
   # Generate insights
   ```

4. Specialized tools workflow:
   - Identify appropriate library
   - Install if needed
   - Process with tool-specific approach
```

**When to use:**
- Multiple valid approaches exist
- Decision depends on input characteristics
- Different paths require different tools/techniques

**Note:** If workflows become large (>100 lines each), push them into separate files and tell Claude to read the appropriate file based on task type.

---

## Progressive Disclosure Pattern

Organize content so Claude loads details only when needed.

### High-Level Guide with References

````markdown
---
name: pdf-processing
description: Extracts text and tables from PDF files, fills forms, and merges documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# PDF Processing

## Quick Start

Extract text with pdfplumber:
```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

## Advanced Features

**Form filling**: See [FORMS.md](FORMS.md) for complete guide
**API reference**: See [REFERENCE.md](REFERENCE.md) for all methods
**Examples**: See [EXAMPLES.md](EXAMPLES.md) for common patterns
````

**Directory structure:**
```
pdf-processing/
├── SKILL.md (overview, <500 lines)
├── FORMS.md (form filling details)
├── REFERENCE.md (API documentation)
└── EXAMPLES.md (usage examples)
```

### Domain-Specific Organization

For Skills covering multiple domains, organize by domain to avoid loading irrelevant context.

````markdown
# BigQuery Data Analysis

## Available Datasets

**Finance**: Revenue, ARR, billing → See [reference/finance.md](reference/finance.md)
**Sales**: Opportunities, pipeline, accounts → See [reference/sales.md](reference/sales.md)
**Product**: API usage, features, adoption → See [reference/product.md](reference/product.md)
**Marketing**: Campaigns, attribution, email → See [reference/marketing.md](reference/marketing.md)

## Quick Search

Find specific metrics using grep:

```bash
grep -i "revenue" reference/finance.md
grep -i "pipeline" reference/sales.md
grep -i "api usage" reference/product.md
```
````

**Directory structure:**
```
bigquery-skill/
├── SKILL.md (overview and navigation)
└── reference/
    ├── finance.md (revenue metrics)
    ├── sales.md (pipeline data)
    ├── product.md (usage analytics)
    └── marketing.md (campaigns)
```

### Conditional Details

Show basic content, link to advanced content:

```markdown
# DOCX Processing

## Creating Documents

Use docx-js for new documents. See [DOCX-JS.md](DOCX-JS.md).

## Editing Documents

For simple edits, modify the XML directly.

**For tracked changes**: See [REDLINING.md](REDLINING.md)
**For OOXML details**: See [OOXML.md](OOXML.md)
```

**When to use progressive disclosure:**
- SKILL.md exceeds or approaches 500 lines
- Skill covers multiple distinct domains
- Detailed reference material (API docs, schemas)
- Advanced features not always needed

**Important:**
- Keep references one level deep (no nested references)
- For files >100 lines, include table of contents at top

---

## Feedback Loop Pattern

Implement validation and iteration cycles for quality-critical tasks.

### Style Guide Compliance (non-code)

```markdown
## Content review process

1. Draft your content following the guidelines in STYLE_GUIDE.md
2. Review against the checklist:
   - Check terminology consistency
   - Verify examples follow the standard format
   - Confirm all required sections are present
3. If issues found:
   - Note each issue with specific section reference
   - Revise the content
   - Review the checklist again
4. Only proceed when all requirements are met
5. Finalize and save the document
```

### Document Editing with Validation (with code)

```markdown
## Document editing process

1. Make your edits to `word/document.xml`
2. **Validate immediately**: `python ooxml/scripts/validate.py unpacked_dir/`
3. If validation fails:
   - Review the error message carefully
   - Fix the issues in the XML
   - Run validation again
4. **Only proceed when validation passes**
5. Rebuild: `python ooxml/scripts/pack.py unpacked_dir/ output.docx`
6. Test the output document
```

### Plan-Validate-Execute Pattern

For complex operations with many possible errors:

````markdown
## Batch Form Update Process

1. **Create plan file**: Generate `changes.json` with all intended updates
   ```json
   {
     "field_name": "new_value",
     "signature_date": "2024-01-15"
   }
   ```

2. **Validate plan**: Run validation script
   ```bash
   python scripts/validate_changes.py changes.json template.pdf
   ```

   Script checks:
   - All field names exist in template
   - Values match expected format
   - No conflicting updates
   - Required fields present

3. **Review validation output**: Fix any errors in `changes.json`

4. **Execute when validation passes**:
   ```bash
   python scripts/apply_changes.py template.pdf changes.json output.pdf
   ```

5. **Verify final output**: Check the generated PDF
```

**When to use feedback loops:**
- Operations are error-prone
- Quality requirements are strict
- Mistakes are costly to fix later
- Multiple validation rules apply

**Implementation tips:**
- Make validation scripts verbose with specific error messages
- Point to exactly what's wrong: "Field 'signature_date' not found. Available fields: customer_name, order_total, signature_date_signed"
- Allow iteration without touching originals

---

## Domain Organization Pattern

Organize large Skills by functional domain to minimize context loading.

### Multi-Domain Skill Structure

```
enterprise-skill/
├── SKILL.md (navigation and overview)
├── domains/
│   ├── authentication.md
│   ├── billing.md
│   ├── analytics.md
│   └── notifications.md
└── common/
    └── utilities.md
```

### Navigation in SKILL.md

````markdown
# Enterprise Platform Skill

## Domain Areas

This Skill covers multiple platform domains. Navigate to the relevant domain:

**Authentication & Authorization**: User login, SSO, permissions → [authentication.md](domains/authentication.md)
**Billing & Payments**: Subscriptions, invoicing, payment processing → [billing.md](domains/billing.md)
**Analytics & Reporting**: Metrics, dashboards, data exports → [analytics.md](domains/analytics.md)
**Notifications**: Email, SMS, push notifications → [notifications.md](domains/notifications.md)

**Common utilities**: [utilities.md](common/utilities.md)

## Finding Information

Use grep to search across domains:
```bash
grep -r "search term" domains/
```
````

**When to use:**
- Skill covers multiple distinct functional areas
- Each domain has substantial documentation
- Users typically work in one domain at a time
- Minimizing context usage is important

---

## Combining Patterns

Patterns work well together. Common combinations:

### Workflow + Feedback Loop
Multi-step process with validation at each step.

### Progressive Disclosure + Domain Organization
Large Skill organized by domain, each domain file using progressive disclosure.

### Template + Examples
Provide template structure, then show filled examples.

### Conditional Workflow + Progressive Disclosure
Decision tree in SKILL.md, each branch points to detailed workflow file.

---

## Pattern Selection Guide

| Scenario | Recommended Pattern |
|----------|-------------------|
| Consistent output format needed | Template Pattern |
| Style/format has nuances | Examples Pattern |
| Multi-step process | Workflow Pattern |
| Multiple approaches possible | Conditional Workflow Pattern |
| Content exceeds 500 lines | Progressive Disclosure Pattern |
| Error-prone operations | Feedback Loop Pattern |
| Multiple functional areas | Domain Organization Pattern |
| Need format consistency + examples | Template + Examples |
| Complex process with validation | Workflow + Feedback Loop |
| Large multi-domain Skill | Domain Organization + Progressive Disclosure |
