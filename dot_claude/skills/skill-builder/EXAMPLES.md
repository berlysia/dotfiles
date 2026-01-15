# Complete Skill Examples

This document provides complete, working examples of Skills at different complexity levels.

## Contents

- Simple Skill: Single File
- Moderate Skill: Multiple Files
- Complex Skill: Full Progressive Disclosure
- Specialized Patterns
  - Read-Only Skill with Tool Restrictions
  - Forked Context Skill
  - Skill with Utility Scripts

---

## Simple Skill: Single File

A minimal Skill for generating commit messages.

### Directory Structure

```
commit-helper/
└── SKILL.md
```

### SKILL.md

````markdown
---
name: generating-commit-messages
description: Generates clear commit messages from git diffs. Use when writing commit messages, reviewing staged changes, or when user asks for help with commits.
---

# Generating Commit Messages

## Process

When asked to generate a commit message:

1. **Review changes**: Run `git diff --staged` to see what's being committed

2. **Analyze the changes**:
   - What functionality changed?
   - What components are affected?
   - Is this a fix, feature, refactor, or chore?

3. **Generate message** with this structure:
   ```
   <type>(<scope>): <short summary>

   <detailed description if needed>
   ```

## Message Guidelines

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `docs`: Documentation changes
- `test`: Adding or updating tests
- `chore`: Maintenance (dependencies, config, etc.)

**Summary line:**
- 50 characters or less
- Present tense: "add feature" not "added feature"
- No period at end
- Lowercase after colon

**Detailed description (when needed):**
- Explain "why" not "what"
- Include context for non-obvious changes
- Reference issue numbers if applicable

## Examples

**Simple feature:**
```
feat(auth): add password reset functionality
```

**Bug fix with context:**
```
fix(api): prevent race condition in user creation

Multiple simultaneous requests could create duplicate users.
Add transaction lock to ensure atomicity.
```

**Refactor:**
```
refactor(database): extract query builders into separate module

Improves testability and reusability of query logic.
```
````

**Why this works:**
- Description includes trigger keywords: "commit messages", "staged changes", "commits"
- Instructions are concise (under 500 lines)
- Examples show the pattern clearly
- No unnecessary explanations of git basics

---

## Moderate Skill: Multiple Files

A PDF processing Skill with reference documentation.

### Directory Structure

```
pdf-processing/
├── SKILL.md
├── FORMS.md
└── REFERENCE.md
```

### SKILL.md

````markdown
---
name: processing-pdfs
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when user mentions PDFs, forms, or document extraction. Requires pdfplumber and pypdf packages.
---

# PDF Processing

## Quick Start

### Extract Text

Use pdfplumber for text extraction:

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    # Extract from first page
    text = pdf.pages[0].extract_text()

    # Extract from all pages
    all_text = ""
    for page in pdf.pages:
        all_text += page.extract_text()
```

### Extract Tables

```python
with pdfplumber.open("document.pdf") as pdf:
    tables = pdf.pages[0].extract_tables()
    for table in tables:
        # Process table data
        print(table)
```

## Advanced Features

**Form filling**: See [FORMS.md](FORMS.md) for complete form filling guide

**Complete API reference**: See [REFERENCE.md](REFERENCE.md) for all pdfplumber and pypdf methods

## Requirements

Install required packages:
```bash
pip install pdfplumber pypdf
```

Verify installation:
```python
import pdfplumber
import pypdf
print("Packages installed successfully")
```
````

### FORMS.md

````markdown
# PDF Form Filling Guide

## Overview

PDF forms contain interactive fields that can be filled programmatically using pypdf.

## Basic Form Filling

```python
from pypdf import PdfReader, PdfWriter

# Open form template
reader = PdfReader("form_template.pdf")
writer = PdfWriter()

# Get form fields
page = reader.pages[0]
writer.add_page(page)

# Fill fields
writer.update_page_form_field_values(
    writer.pages[0],
    {
        "name": "John Doe",
        "email": "john@example.com",
        "date": "2024-01-15"
    }
)

# Save filled form
with open("filled_form.pdf", "wb") as output:
    writer.write(output)
```

## Discovering Form Fields

To see what fields are available:

```python
from pypdf import PdfReader

reader = PdfReader("form_template.pdf")
fields = reader.get_fields()

for field_name, field_info in fields.items():
    print(f"Field: {field_name}")
    print(f"  Type: {field_info.get('/FT')}")
    print(f"  Value: {field_info.get('/V')}")
```

## Common Field Types

- **Text fields**: Single-line or multi-line text
- **Checkboxes**: Boolean values
- **Radio buttons**: One selection from group
- **Dropdowns**: Select from list

## Handling Different Field Types

### Text Fields

```python
writer.update_page_form_field_values(
    writer.pages[0],
    {"text_field_name": "Text content"}
)
```

### Checkboxes

```python
writer.update_page_form_field_values(
    writer.pages[0],
    {"checkbox_name": "/Yes"}  # or "/Off" to uncheck
)
```

### Radio Buttons

```python
writer.update_page_form_field_values(
    writer.pages[0],
    {"radio_group_name": "/Option1"}
)
```

## Flattening Forms

After filling, flatten the form to make it non-editable:

```python
# After updating fields
writer.flatten_annotations()  # Makes form read-only
```

## Complete Example

```python
from pypdf import PdfReader, PdfWriter

def fill_form(template_path, field_values, output_path):
    """Fill PDF form with provided values."""
    reader = PdfReader(template_path)
    writer = PdfWriter()

    # Add all pages
    for page in reader.pages:
        writer.add_page(page)

    # Fill form fields
    writer.update_page_form_field_values(
        writer.pages[0],
        field_values
    )

    # Optional: flatten to prevent further editing
    # writer.flatten_annotations()

    # Save
    with open(output_path, "wb") as output:
        writer.write(output)

# Usage
fill_form(
    "template.pdf",
    {
        "name": "John Doe",
        "email": "john@example.com",
        "subscribe": "/Yes"
    },
    "filled.pdf"
)
```
````

### REFERENCE.md

````markdown
# PDF Processing API Reference

Quick reference for pdfplumber and pypdf methods.

## Contents

- pdfplumber Methods
- pypdf Methods
- Common Patterns

---

## pdfplumber Methods

### Opening PDFs

```python
import pdfplumber

# Open PDF
with pdfplumber.open("file.pdf") as pdf:
    # Work with PDF
    pass

# Access metadata
pdf.metadata  # Dict of PDF metadata
```

### Page Operations

```python
# Get specific page
page = pdf.pages[0]  # First page (0-indexed)

# Page properties
page.width
page.height
page.bbox  # Bounding box (x0, y0, x1, y1)
```

### Text Extraction

```python
# Extract all text from page
text = page.extract_text()

# Extract text with layout preservation
text = page.extract_text(layout=True)

# Extract words as list
words = page.extract_words()
# Returns: [{"text": "word", "x0": ..., "y0": ..., ...}, ...]
```

### Table Extraction

```python
# Extract all tables from page
tables = page.extract_tables()

# Extract with custom settings
tables = page.extract_tables(
    table_settings={
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines"
    }
)

# Returns: List of tables, each table is list of rows
# [[cell1, cell2, ...], [cell1, cell2, ...], ...]
```

---

## pypdf Methods

### Reading PDFs

```python
from pypdf import PdfReader

reader = PdfReader("file.pdf")

# Get page count
num_pages = len(reader.pages)

# Get page
page = reader.pages[0]

# Extract text
text = page.extract_text()

# Get metadata
metadata = reader.metadata
```

### Writing PDFs

```python
from pypdf import PdfWriter

writer = PdfWriter()

# Add page
writer.add_page(page)

# Write to file
with open("output.pdf", "wb") as f:
    writer.write(f)
```

### Merging PDFs

```python
from pypdf import PdfMerger

merger = PdfMerger()

# Append entire PDF
merger.append("file1.pdf")
merger.append("file2.pdf")

# Append specific pages
merger.append("file3.pdf", pages=(0, 2))  # First 2 pages

# Write merged PDF
merger.write("merged.pdf")
merger.close()
```

---

## Common Patterns

### Extract text from entire PDF

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    all_text = ""
    for page in pdf.pages:
        all_text += page.extract_text() + "\n"
```

### Extract tables from all pages

```python
with pdfplumber.open("document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        tables = page.extract_tables()
        all_tables.extend(tables)
```

### Search for text

```python
import pdfplumber

def find_text(pdf_path, search_term):
    """Find pages containing search term."""
    results = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text()
            if search_term.lower() in text.lower():
                results.append(i + 1)  # 1-indexed page numbers
    return results
```

### Split PDF

```python
from pypdf import PdfReader, PdfWriter

def split_pdf(input_path, output_prefix):
    """Split PDF into individual pages."""
    reader = PdfReader(input_path)
    for i, page in enumerate(reader.pages):
        writer = PdfWriter()
        writer.add_page(page)
        with open(f"{output_prefix}_{i+1}.pdf", "wb") as output:
            writer.write(output)
```
````

**Why this works:**
- SKILL.md stays focused on quick start (<500 lines)
- Complex details moved to FORMS.md and REFERENCE.md
- Progressive disclosure: Claude loads detailed docs only when needed
- Clear navigation from main file to references
- References are one level deep (no nested links)

---

## Complex Skill: Full Progressive Disclosure

BigQuery analysis Skill organized by domain.

### Directory Structure

```
bigquery-analysis/
├── SKILL.md
└── reference/
    ├── finance.md
    ├── sales.md
    ├── product.md
    └── marketing.md
```

### SKILL.md

````markdown
---
name: analyzing-bigquery-data
description: Analyze data in BigQuery across finance, sales, product, and marketing domains. Use when querying BigQuery, analyzing business metrics, or generating reports from company data.
---

# BigQuery Data Analysis

## Overview

This Skill provides schemas, common queries, and analysis patterns for company BigQuery datasets.

## Available Domains

Navigate to the relevant domain for detailed schemas and query patterns:

**Finance**: Revenue, ARR, billing, subscriptions → [reference/finance.md](reference/finance.md)
**Sales**: Opportunities, pipeline, accounts, deals → [reference/sales.md](reference/sales.md)
**Product**: API usage, features, adoption metrics → [reference/product.md](reference/product.md)
**Marketing**: Campaigns, attribution, email metrics → [reference/marketing.md](reference/marketing.md)

## Quick Search

Find specific metrics using grep:

```bash
# Search for revenue-related fields
grep -i "revenue" reference/finance.md

# Search for pipeline metrics
grep -i "pipeline" reference/sales.md

# Search across all domains
grep -r "conversion" reference/
```

## Common Patterns

### Basic Query Structure

```sql
SELECT
  field1,
  field2,
  COUNT(*) as count
FROM
  `project.dataset.table`
WHERE
  date >= '2024-01-01'
  AND status = 'active'
GROUP BY
  field1, field2
ORDER BY
  count DESC
```

### Filtering Best Practices

**Always exclude test data:**
```sql
WHERE
  email NOT LIKE '%@test.com'
  AND email NOT LIKE '%@example.com'
  AND is_test = FALSE
```

**Date filtering for performance:**
```sql
WHERE
  DATE(created_at) >= '2024-01-01'  -- Use DATE() for partitioned tables
```

## Connection

Use BigQuery MCP server tools to execute queries:
- `BigQuery:execute_query` - Run SQL queries
- `BigQuery:list_tables` - List available tables
- `BigQuery:get_schema` - Get table schema

For domain-specific queries and schemas, see the reference files above.
````

### reference/finance.md (example)

````markdown
# Finance Domain Reference

## Tables

### revenue_events

**Location**: `company-data.finance.revenue_events`

**Partitioned by**: `event_date`

**Schema:**
| Column | Type | Description |
|--------|------|-------------|
| event_id | STRING | Unique event identifier |
| event_date | DATE | Date of revenue event |
| account_id | STRING | Customer account ID |
| amount_usd | NUMERIC | Revenue amount in USD |
| currency | STRING | Original currency |
| event_type | STRING | Type: 'booking', 'collection', 'refund' |
| subscription_id | STRING | Related subscription |
| created_at | TIMESTAMP | Event creation time |

**Common filters:**
```sql
-- Current year revenue
WHERE event_date >= DATE_TRUNC(CURRENT_DATE(), YEAR)

-- Exclude refunds
WHERE event_type != 'refund'

-- Active subscriptions only
WHERE subscription_id IS NOT NULL
```

### arr_snapshots

**Location**: `company-data.finance.arr_snapshots`

**Partitioned by**: `snapshot_date`

**Schema:**
| Column | Type | Description |
|--------|------|-------------|
| snapshot_date | DATE | Date of snapshot |
| account_id | STRING | Customer account ID |
| arr_usd | NUMERIC | Annual Recurring Revenue |
| mrr_usd | NUMERIC | Monthly Recurring Revenue |
| plan_tier | STRING | Subscription tier |
| status | STRING | 'active', 'churned', 'paused' |

## Common Queries

### Monthly Revenue

```sql
SELECT
  DATE_TRUNC(event_date, MONTH) as month,
  SUM(amount_usd) as total_revenue
FROM
  `company-data.finance.revenue_events`
WHERE
  event_date >= '2024-01-01'
  AND event_type IN ('booking', 'collection')
GROUP BY
  month
ORDER BY
  month
```

### ARR by Plan Tier

```sql
SELECT
  plan_tier,
  SUM(arr_usd) as total_arr,
  COUNT(DISTINCT account_id) as customer_count
FROM
  `company-data.finance.arr_snapshots`
WHERE
  snapshot_date = CURRENT_DATE()
  AND status = 'active'
GROUP BY
  plan_tier
ORDER BY
  total_arr DESC
```

### Revenue Growth Rate

```sql
WITH monthly_revenue AS (
  SELECT
    DATE_TRUNC(event_date, MONTH) as month,
    SUM(amount_usd) as revenue
  FROM
    `company-data.finance.revenue_events`
  WHERE
    event_type = 'booking'
  GROUP BY
    month
)
SELECT
  month,
  revenue,
  LAG(revenue) OVER (ORDER BY month) as prev_month,
  (revenue - LAG(revenue) OVER (ORDER BY month)) / LAG(revenue) OVER (ORDER BY month) * 100 as growth_rate_pct
FROM
  monthly_revenue
ORDER BY
  month DESC
```

## Metrics Definitions

**ARR (Annual Recurring Revenue)**: Total annual value of active subscriptions
**MRR (Monthly Recurring Revenue)**: Total monthly value of active subscriptions
**Booking**: Revenue recognized when customer commits
**Collection**: Revenue actually received
**Churn**: Percentage of customers who cancelled
````

**Why this works:**
- SKILL.md provides navigation and common patterns
- Domain-specific details in separate files (finance.md, sales.md, etc.)
- Claude loads only relevant domain when needed
- Each domain file has detailed schemas and queries
- Easy to add new domains without bloating main file
- Grep commands help find specific metrics quickly

---

## Specialized Patterns

### Read-Only Skill with Tool Restrictions

````markdown
---
name: reading-files-safely
description: Read and analyze files without making changes. Use when you need read-only file access, code review, or when analyzing codebase structure.
allowed-tools: Read, Grep, Glob
---

# Safe File Reading

## Purpose

This Skill provides read-only access to files. Claude cannot modify files when this Skill is active.

## Available Operations

**Read files**: Use Read tool to view file contents
**Search content**: Use Grep to find text patterns
**Find files**: Use Glob to match file paths

## Analysis Patterns

### Code Review

1. Read the file being reviewed
2. Grep for potential issues (TODOs, console.log, etc.)
3. Provide feedback without making changes

### Codebase Exploration

1. Glob to find relevant files: `**/*.ts`
2. Read key files to understand structure
3. Grep for specific patterns or functions
4. Summarize findings

## Limitations

- Cannot edit files (Edit tool not allowed)
- Cannot write files (Write tool not allowed)
- Cannot execute code (Bash tool not allowed)
- Read-only analysis only
````

**Why this works:**
- `allowed-tools` restricts to Read, Grep, Glob only
- Clear about limitations upfront
- Useful for code review, analysis scenarios
- Security-conscious: prevents accidental modifications

---

### Forked Context Skill

````markdown
---
name: analyzing-code-quality
description: Perform comprehensive code quality analysis and generate detailed reports. Use when analyzing code quality, technical debt, or generating quality reports.
context: fork
agent: Explore
---

# Code Quality Analysis

## Overview

This Skill runs in an isolated context to perform deep code analysis without cluttering the main conversation.

## Analysis Process

The analysis follows these steps:

1. **Codebase exploration**: Identify all source files
2. **Pattern detection**: Find code smells, duplication, complexity
3. **Metrics calculation**: Cyclomatic complexity, test coverage, documentation
4. **Report generation**: Comprehensive quality report

## What Gets Analyzed

- Code complexity (cyclomatic, cognitive)
- Code duplication (using similarity-ts if available)
- Test coverage patterns
- Documentation completeness
- Common anti-patterns
- Dependency analysis

## Output Format

The analysis produces a structured report:

```markdown
# Code Quality Report

## Executive Summary
[Overall quality score and key findings]

## Complexity Analysis
[Functions/classes with high complexity]

## Code Duplication
[Duplicated code blocks identified]

## Test Coverage
[Areas lacking tests]

## Recommendations
[Prioritized improvement suggestions]
```

## Usage

Simply ask: "Analyze code quality" or "Generate quality report"

The analysis runs in a forked context and returns the complete report to the main conversation.
````

**Why this works:**
- `context: fork` runs in isolated subagent
- `agent: Explore` uses specialized exploration agent
- Complex analysis doesn't clutter main conversation
- Full report returned when complete
- Main conversation stays focused

---

### Skill with Utility Scripts

````markdown
---
name: validating-json-schema
description: Validate JSON files against schemas. Use when checking JSON validity, schema compliance, or data validation.
---

# JSON Schema Validation

## Quick Validation

Use the validation script for quick schema checks:

```bash
python scripts/validate_json.py data.json schema.json
```

Output shows validation results and any errors found.

## Validation Workflow

1. **Prepare files**: Ensure JSON data and schema files exist
2. **Run validator**: Execute validation script
3. **Review errors**: Check output for issues
4. **Fix and revalidate**: Correct errors and validate again

## Detailed Validation

For detailed validation with error context:

```bash
python scripts/validate_json.py --verbose data.json schema.json
```

Verbose mode shows:
- Exact error locations (line, column)
- Error descriptions
- Suggested fixes

## Batch Validation

Validate multiple files:

```bash
python scripts/validate_json.py --batch directory/ schema.json
```

Generates summary report:
- Total files checked
- Files passed
- Files failed with error details

## Custom Schemas

Create schemas for your data structures:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "name": {"type": "string"},
    "age": {"type": "number", "minimum": 0}
  },
  "required": ["name"]
}
```

Save as `.schema.json` and validate against it.

## Common Validation Errors

**Type mismatch**: Value doesn't match expected type
```
Error: Expected number, got string at $.age
Fix: Change "25" to 25
```

**Missing required field**: Required property not present
```
Error: Missing required property 'name'
Fix: Add "name" property to object
```

**Invalid format**: String doesn't match format requirement
```
Error: Invalid email format at $.email
Fix: Ensure email follows name@domain.com pattern
```
````

**scripts/validate_json.py** (example utility):

```python
#!/usr/bin/env python3
"""JSON schema validation utility."""

import argparse
import json
import sys
from pathlib import Path
from jsonschema import validate, ValidationError, SchemaError

def validate_file(data_path, schema_path, verbose=False):
    """Validate JSON file against schema."""
    try:
        with open(data_path) as f:
            data = json.load(f)

        with open(schema_path) as f:
            schema = json.load(f)

        validate(instance=data, schema=schema)

        print(f"✓ {data_path}: Valid")
        return True

    except json.JSONDecodeError as e:
        print(f"✗ {data_path}: Invalid JSON - {e}")
        if verbose:
            print(f"  Line {e.lineno}, Column {e.colno}")
        return False

    except ValidationError as e:
        print(f"✗ {data_path}: Schema validation failed")
        print(f"  {e.message}")
        if verbose:
            print(f"  Path: {' -> '.join(str(p) for p in e.path)}")
        return False

    except SchemaError as e:
        print(f"✗ Schema error: {e.message}")
        return False

    except FileNotFoundError as e:
        print(f"✗ File not found: {e.filename}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Validate JSON against schema")
    parser.add_argument("data", help="JSON data file or directory")
    parser.add_argument("schema", help="JSON schema file")
    parser.add_argument("--verbose", "-v", action="store_true",
                       help="Show detailed error information")
    parser.add_argument("--batch", "-b", action="store_true",
                       help="Validate all JSON files in directory")

    args = parser.parse_args()

    if args.batch:
        # Batch validation
        data_dir = Path(args.data)
        if not data_dir.is_dir():
            print(f"Error: {args.data} is not a directory")
            sys.exit(1)

        files = list(data_dir.glob("**/*.json"))
        if not files:
            print(f"No JSON files found in {args.data}")
            sys.exit(1)

        results = []
        for file_path in files:
            result = validate_file(file_path, args.schema, args.verbose)
            results.append((file_path.name, result))

        # Summary
        print("\nSummary:")
        print(f"Total files: {len(results)}")
        print(f"Passed: {sum(1 for _, r in results if r)}")
        print(f"Failed: {sum(1 for _, r in results if not r)}")

        sys.exit(0 if all(r for _, r in results) else 1)
    else:
        # Single file validation
        result = validate_file(args.data, args.schema, args.verbose)
        sys.exit(0 if result else 1)

if __name__ == "__main__":
    main()
```

**Why this works:**
- Script handles complexity (validation logic)
- Claude just executes script, no need to generate validation code
- Script provides clear error messages pointing to solutions
- Verbose mode for debugging
- Batch mode for multiple files
- Zero context cost to execute (only output consumes tokens)
- More reliable than generated code

---

## Key Takeaways

1. **Start simple**: Single file Skill often sufficient
2. **Add complexity as needed**: Progressive disclosure for large Skills
3. **Test with real scenarios**: Examples should reflect actual usage
4. **Iterate based on observation**: Watch how Claude uses the Skill
5. **Follow patterns**: Use established patterns for common needs
6. **Bundle scripts**: Pre-written scripts more reliable than generated code
7. **Organize by domain**: Large Skills benefit from domain organization
8. **Restrict tools appropriately**: Use `allowed-tools` for security
9. **Fork when needed**: Complex analysis benefits from isolated context
10. **Keep description specific**: Include trigger keywords users would say
