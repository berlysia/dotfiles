# Dependency Array Management

This reference provides comprehensive guidance for correctly managing dependency arrays in React hooks.

## Fundamental Rules

### Rule 1: Include All Referenced Values

Every value from the component scope that the effect/callback/memo uses must be in the dependency array:

```tsx
// ❌ WRONG: Missing dependency
function SearchResults({ query, filters }: Props) {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    fetchResults(query, filters).then(setResults);
  }, [query]); // Missing `filters`

  return <ResultList results={results} />;
}

// ✅ CORRECT: All dependencies included
function SearchResults({ query, filters }: Props) {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    fetchResults(query, filters).then(setResults);
  }, [query, filters]); // Both included

  return <ResultList results={results} />;
}
```

### Rule 2: Never Lie About Dependencies

Do not suppress ESLint warnings by removing dependencies:

```tsx
// ❌ WRONG: Suppressing lint warning
useEffect(() => {
  const timer = setInterval(() => {
    setCount(count + 1); // Uses `count`
  }, 1000);
  return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // Lying about dependencies

// ✅ CORRECT: Use functional update
useEffect(() => {
  const timer = setInterval(() => {
    setCount(c => c + 1); // No external dependency
  }, 1000);
  return () => clearInterval(timer);
}, []); // Honestly empty
```

### Rule 3: Stable vs Unstable References

Understand what creates new references:

| Always Stable | Unstable (new each render) |
|---------------|---------------------------|
| `useState` setter | Inline objects `{}` |
| `useReducer` dispatch | Inline arrays `[]` |
| `useRef` object | Inline functions `() => {}` |
| Module-level values | Props (objects/arrays/functions) |
| Constants | Computed objects/arrays |

```tsx
// ❌ WRONG: Inline object creates new reference
function Component({ userId }: { userId: string }) {
  useEffect(() => {
    fetch('/api', { body: JSON.stringify({ userId }) });
  }, [{ userId }]); // New object every render = infinite loop

  return null;
}

// ✅ CORRECT: Use primitive or memoize
function Component({ userId }: { userId: string }) {
  useEffect(() => {
    fetch('/api', { body: JSON.stringify({ userId }) });
  }, [userId]); // Primitive is stable

  return null;
}
```

## Common Patterns and Solutions

### Pattern 1: Object/Array Props

Problem: Object/array props are new references each render.

```tsx
// Parent creates new object each render
<Child options={{ theme: 'dark', size: 'large' }} />

// Child's effect runs every render
function Child({ options }: { options: Options }) {
  useEffect(() => {
    applyOptions(options);
  }, [options]); // Runs every render!
}
```

**Solution A: Memoize in parent**

```tsx
const options = useMemo(() => ({ theme: 'dark', size: 'large' }), []);
<Child options={options} />
```

**Solution B: Destructure to primitives**

```tsx
function Child({ options }: { options: Options }) {
  const { theme, size } = options;

  useEffect(() => {
    applyOptions({ theme, size });
  }, [theme, size]); // Primitives are stable
}
```

**Solution C: JSON comparison (last resort)**

```tsx
function useDeepCompareEffect(
  callback: EffectCallback,
  dependencies: DependencyList
) {
  const ref = useRef<string>();
  const signatureKey = JSON.stringify(dependencies);

  useEffect(() => {
    if (ref.current !== signatureKey) {
      ref.current = signatureKey;
      return callback();
    }
  });
}
```

### Pattern 2: Callback Props

Problem: Callback props are new functions each render.

```tsx
// Parent
<SearchInput onSearch={(q) => setQuery(q)} /> // New function each render

// Child
function SearchInput({ onSearch }: { onSearch: (q: string) => void }) {
  const [value, setValue] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => onSearch(value), 300);
    return () => clearTimeout(timer);
  }, [value, onSearch]); // onSearch changes = timer resets!
}
```

**Solution A: useCallback in parent**

```tsx
const handleSearch = useCallback((q: string) => setQuery(q), []);
<SearchInput onSearch={handleSearch} />
```

**Solution B: useRef to capture latest**

```tsx
function SearchInput({ onSearch }: Props) {
  const [value, setValue] = useState('');
  const onSearchRef = useRef(onSearch);

  useEffect(() => {
    onSearchRef.current = onSearch;
  });

  useEffect(() => {
    const timer = setTimeout(() => onSearchRef.current(value), 300);
    return () => clearTimeout(timer);
  }, [value]); // onSearch not needed
}
```

### Pattern 3: Functions Defined in Component

Problem: Functions defined in component body are new each render.

```tsx
// ❌ WRONG: fetchData is new each render
function UserProfile({ userId }: { userId: string }) {
  const fetchData = async () => {
    const response = await fetch(`/api/users/${userId}`);
    return response.json();
  };

  useEffect(() => {
    fetchData().then(setUser);
  }, [fetchData]); // Infinite loop!
}
```

**Solution A: Move function inside effect**

```tsx
function UserProfile({ userId }: { userId: string }) {
  useEffect(() => {
    const fetchData = async () => {
      const response = await fetch(`/api/users/${userId}`);
      return response.json();
    };

    fetchData().then(setUser);
  }, [userId]);
}
```

**Solution B: useCallback if function needed elsewhere**

```tsx
function UserProfile({ userId }: { userId: string }) {
  const fetchData = useCallback(async () => {
    const response = await fetch(`/api/users/${userId}`);
    return response.json();
  }, [userId]);

  useEffect(() => {
    fetchData().then(setUser);
  }, [fetchData]);

  return <button onClick={fetchData}>Refresh</button>;
}
```

**Solution C: Move to module scope (if no component state needed)**

```tsx
// Outside component
async function fetchUser(userId: string) {
  const response = await fetch(`/api/users/${userId}`);
  return response.json();
}

function UserProfile({ userId }: { userId: string }) {
  useEffect(() => {
    fetchUser(userId).then(setUser);
  }, [userId]);
}
```

### Pattern 4: Conditional Dependencies

Problem: Dependencies change based on conditions.

```tsx
// ❌ WRONG: Conditional hook call
function SearchInput({ mode }: { mode: 'local' | 'remote' }) {
  if (mode === 'remote') {
    useEffect(() => { /* ... */ }, [query]); // Conditional hook!
  }
}
```

**Solution: Include condition in logic**

```tsx
function SearchInput({ mode, query }: Props) {
  useEffect(() => {
    if (mode !== 'remote') return;

    const controller = new AbortController();
    fetch(`/search?q=${query}`, { signal: controller.signal })
      .then(r => r.json())
      .then(setResults);

    return () => controller.abort();
  }, [mode, query]); // Always include both
}
```

### Pattern 5: Initial Value Only

Problem: Want to run effect only once but ESLint requires dependencies.

```tsx
// ❌ WRONG: Suppressing lint
useEffect(() => {
  initializeLibrary(config);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**Solution A: Move to ref (if value shouldn't trigger re-run)**

```tsx
function Component({ config }: { config: Config }) {
  const configRef = useRef(config);

  useEffect(() => {
    initializeLibrary(configRef.current);
  }, []); // Legitimately empty
}
```

**Solution B: Handle in initialization**

```tsx
function Component({ initialConfig }: { initialConfig: Config }) {
  const [config] = useState(initialConfig); // Captures initial

  useEffect(() => {
    initializeLibrary(config);
  }, [config]); // Only runs once
}
```

## Empty Dependency Array `[]`

### When Empty Array Is Correct

```tsx
// ✅ Mount/unmount only, no dependencies
useEffect(() => {
  const subscription = eventBus.subscribe(handleEvent);
  return () => subscription.unsubscribe();
}, []);

// ✅ One-time DOM setup
useEffect(() => {
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      handleResize(entry);
    }
  });
  observer.observe(containerRef.current!);
  return () => observer.disconnect();
}, []);
```

### When Empty Array Is Wrong

```tsx
// ❌ WRONG: Uses external values
useEffect(() => {
  document.title = `${count} items`; // Uses `count`
}, []); // Should be [count]

// ❌ WRONG: Callback uses component state
useEffect(() => {
  const handler = () => {
    if (isEnabled) { // Uses `isEnabled`
      doSomething();
    }
  };
  window.addEventListener('click', handler);
  return () => window.removeEventListener('click', handler);
}, []); // Should be [isEnabled]
```

## Debugging Dependency Issues

### Using ESLint Plugin

Enable `eslint-plugin-react-hooks`:

```json
{
  "plugins": ["react-hooks"],
  "rules": {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn"
  }
}
```

### Identifying Stale Closures

Symptoms of stale closure:
- Effect uses outdated state/props values
- Handlers reference old values
- Computed values don't update

```tsx
// Stale closure example
function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      console.log(count); // Always logs initial value (0)!
    }, 1000);
    return () => clearInterval(timer);
  }, []); // count is stale

  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```

### Debugging Steps

1. **Check ESLint warnings** - Never ignore them
2. **Log dependency values** - Add `console.log` before effect
3. **Use React DevTools** - Inspect component state
4. **Check reference equality** - `console.log(Object.is(prev, next))`

```tsx
// Debug helper
function useWhyDidYouUpdate<T extends Record<string, unknown>>(
  name: string,
  props: T
) {
  const previousProps = useRef<T>();

  useEffect(() => {
    if (previousProps.current) {
      const allKeys = Object.keys({ ...previousProps.current, ...props });
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      allKeys.forEach(key => {
        if (previousProps.current![key] !== props[key]) {
          changes[key] = {
            from: previousProps.current![key],
            to: props[key],
          };
        }
      });

      if (Object.keys(changes).length) {
        console.log('[why-did-you-update]', name, changes);
      }
    }

    previousProps.current = props;
  });
}
```

## Reference Stability Patterns

### Stable Object References

```tsx
// Using useRef for stable object
function Component() {
  const stableConfig = useRef({
    option1: 'value1',
    option2: 'value2',
  }).current;

  useEffect(() => {
    initialize(stableConfig);
  }, [stableConfig]); // Reference never changes
}

// Using useMemo for computed stable object
function Component({ width, height }: Props) {
  const dimensions = useMemo(
    () => ({ width, height }),
    [width, height]
  );

  useEffect(() => {
    resize(dimensions);
  }, [dimensions]); // Only changes when width/height change
}
```

### Stable Function References

```tsx
// Module-level function (always stable)
function formatDate(date: Date): string {
  return date.toISOString();
}

// useCallback for component functions
function Component({ onSave }: Props) {
  const handleSave = useCallback(() => {
    const data = gatherData();
    onSave(data);
  }, [onSave]);

  useEffect(() => {
    registerSaveHandler(handleSave);
    return () => unregisterSaveHandler(handleSave);
  }, [handleSave]);
}
```

## Summary Checklist

When writing dependency arrays:

- [ ] All values from component scope are included
- [ ] No ESLint warnings are suppressed without valid reason
- [ ] Object/array dependencies are memoized or destructured
- [ ] Function dependencies use useCallback or are moved inside effect
- [ ] Empty arrays `[]` truly have no dependencies
- [ ] Conditional logic is inside the effect, not around it
- [ ] State setters use functional updates to avoid dependencies
- [ ] Refs are used appropriately for "latest value" patterns

**Key Principle**: The dependency array describes what the effect depends on, not when it should run. Allow React to optimize based on accurate dependencies rather than attempting to control timing manually.
