# Record Learnings

User action to record important learnings from recent conversations to `.claude/memory/<timestamp>-<task-summary>.md`.

## Process

1. **Conversation History Analysis**

   - Review recent conversation content
   - Identify technical discoveries, solutions, and patterns
   - Record error-solution pairs
   - Identify effective and failed approaches

2. **Learning Classification**

   - **Technical Knowledge**: New technologies, libraries, API usage
   - **Problem-Solving Patterns**: Effective approaches to specific problems
   - **Development Methods**: Efficient workflows and procedures
   - **Error Handling**: Common errors and their solutions
   - **Tool Utilization**: Useful commands and tool usage

3. **Recording Format**

   ```markdown
   ## [Date] [Category]

   ### Situation

   [What situation occurred]

   ### Learning

   [What was specifically learned]

   ### Application

   [How to utilize in the future]

   ---
   ```

4. **Example Recording Content**
   - Project structure understanding methods
   - Effective debugging techniques
   - Performance optimization approaches
   - Library selection criteria
   - Issues found in code reviews
   - Test strategy improvements
   - Security implementation methods
   - Repeatedly received feedback points

## Implementation

1. **Memory File Check/Creation**

   - Check if `.claude/memory/<timestamp>-<task-summary>.md` exists
   - Create with appropriate headers if it doesn't exist

2. **Learning Extraction**

   - Identify important points from recent conversations
   - Organize as reusable knowledge
   - Include concrete examples and code snippets

3. **Record Addition**
   - Add records in chronological order
   - Structure for easy searchability
   - Include relevant tags and keywords

## Usage Examples

### Technical Discovery Recording

```markdown
## 2024-06-26 TypeScript

### Situation

Struggling with generic constraints while implementing type-safe API client

### Learning

Combining `keyof` and `extends` enables type constraints based on object keys

### Application

Use when defining API response types to guarantee specific field existence
```

### Problem-Solving Pattern Recording

```markdown
## 2024-06-26 Debugging

### Situation

React component experiencing infinite rendering

### Learning

Directly specifying objects in useEffect dependency array causes infinite loops due to new references each time

### Application

Use useCallback and useMemo appropriately, limit dependency arrays to primitives
```

## Key Benefits

- **Knowledge Accumulation**: Learned insights are never lost
- **Pattern Recognition**: Early detection of similar problems
- **Efficiency Improvement**: Reuse of past solutions
- **Team Sharing**: Knowledge sharing and best practice accumulation
- **Learning Acceleration**: Learning from past failures

## Notes

- Limit recordings to specific and practical content
- Include only verified and tested code snippets
- Regularly review and update outdated information
- Do not record private or confidential information
