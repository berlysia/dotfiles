# Eliminating Unnecessary Hooks

This reference provides comprehensive patterns for identifying and removing unnecessary React hooks usage.

## The Cost of Unnecessary Hooks

Every hook adds:
- **Cognitive load**: More code to understand and maintain
- **Runtime overhead**: React tracks hook state and dependencies
- **Bug surface**: Incorrect dependencies, stale closures, infinite loops
- **Bundle size**: More code shipped to users

## Pattern 1: Derived State Anti-Pattern

### Problem: useState + useEffect for Computed Values

This is the most common anti-pattern. Storing values that can be computed from existing state/props.

```tsx
// ❌ WRONG: 3 hooks, sync issues, extra renders
interface Product {
  id: string;
  price: number;
  quantity: number;
}

function Cart({ products }: { products: Product[] }) {
  const [total, setTotal] = useState(0);
  const [itemCount, setItemCount] = useState(0);
  const [hasDiscount, setHasDiscount] = useState(false);

  useEffect(() => {
    const newTotal = products.reduce((sum, p) => sum + p.price * p.quantity, 0);
    setTotal(newTotal);
    setItemCount(products.length);
    setHasDiscount(newTotal > 100);
  }, [products]);

  return (
    <div>
      <p>Items: {itemCount}</p>
      <p>Total: ${total}</p>
      {hasDiscount && <p>Discount applied!</p>}
    </div>
  );
}
```

```tsx
// ✅ CORRECT: 0 hooks, always in sync, single render
function Cart({ products }: { products: Product[] }) {
  const total = products.reduce((sum, p) => sum + p.price * p.quantity, 0);
  const itemCount = products.length;
  const hasDiscount = total > 100;

  return (
    <div>
      <p>Items: {itemCount}</p>
      <p>Total: ${total}</p>
      {hasDiscount && <p>Discount applied!</p>}
    </div>
  );
}
```

### When Memoization IS Needed

Only memoize when computation is expensive AND component re-renders frequently:

```tsx
// ✅ Appropriate: Expensive sort operation
function DataTable({ data, sortConfig }: Props) {
  const sortedData = useMemo(() => {
    // O(n log n) operation on potentially large dataset
    return [...data].sort((a, b) => {
      const aVal = a[sortConfig.key];
      const bVal = b[sortConfig.key];
      return sortConfig.direction === 'asc'
        ? compare(aVal, bVal)
        : compare(bVal, aVal);
    });
  }, [data, sortConfig]);

  return <Table data={sortedData} />;
}
```

## Pattern 2: Event Response Anti-Pattern

### Problem: useEffect to Respond to User Actions

```tsx
// ❌ WRONG: Effect chain, delayed response, race conditions
function SearchForm() {
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    if (query.length > 2) {
      setIsSearching(true);
      analytics.track('search_started', { query });
    }
  }, [query]);

  useEffect(() => {
    if (isSearching) {
      fetchResults(query).then(results => {
        setIsSearching(false);
        setResults(results);
      });
    }
  }, [isSearching, query]);

  return (
    <input
      value={query}
      onChange={e => setQuery(e.target.value)}
    />
  );
}
```

```tsx
// ✅ CORRECT: Direct event handling, immediate response
function SearchForm() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async (newQuery: string) => {
    setQuery(newQuery);

    if (newQuery.length > 2) {
      analytics.track('search_started', { query: newQuery });
      setIsSearching(true);

      const results = await fetchResults(newQuery);
      setResults(results);
      setIsSearching(false);
    }
  };

  return (
    <input
      value={query}
      onChange={e => handleSearch(e.target.value)}
    />
  );
}
```

## Pattern 3: Props-to-State Sync Anti-Pattern

### Problem: Syncing Props to State with useEffect

```tsx
// ❌ WRONG: Stale state, sync bugs, unnecessary complexity
function EditableField({ initialValue, onSave }: Props) {
  const [value, setValue] = useState(initialValue);

  // This creates bugs when initialValue changes!
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  return (
    <input
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={() => onSave(value)}
    />
  );
}
```

### Solution A: Use Key for Full Reset

```tsx
// ✅ Parent controls reset via key
<EditableField
  key={recordId}  // Changes when record changes
  initialValue={record.name}
  onSave={handleSave}
/>

function EditableField({ initialValue, onSave }: Props) {
  const [value, setValue] = useState(initialValue);
  // No useEffect needed - key handles reset

  return (
    <input
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={() => onSave(value)}
    />
  );
}
```

### Solution B: Fully Controlled Component

```tsx
// ✅ Parent owns all state
function EditableField({ value, onChange, onSave }: Props) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      onBlur={() => onSave(value)}
    />
  );
}
```

### Solution C: Derive Edit State

```tsx
// ✅ Track "isDirty" without syncing
function EditableField({ initialValue, onSave }: Props) {
  const [editedValue, setEditedValue] = useState<string | null>(null);

  const displayValue = editedValue ?? initialValue;
  const isDirty = editedValue !== null;

  const handleSave = () => {
    if (isDirty) {
      onSave(editedValue);
      setEditedValue(null);
    }
  };

  return (
    <input
      value={displayValue}
      onChange={e => setEditedValue(e.target.value)}
      onBlur={handleSave}
    />
  );
}
```

## Pattern 4: Premature Memoization

### Problem: useMemo/useCallback Everywhere

```tsx
// ❌ WRONG: Premature optimization
function UserProfile({ user }: { user: User }) {
  // Unnecessary: string concatenation is cheap
  const fullName = useMemo(
    () => `${user.firstName} ${user.lastName}`,
    [user.firstName, user.lastName]
  );

  // Unnecessary: inline function is fine for standard elements
  const handleClick = useCallback(() => {
    console.log('clicked');
  }, []);

  // Unnecessary: simple filter is O(n) but n is small
  const activeItems = useMemo(
    () => user.items.filter(i => i.active),
    [user.items]
  );

  return (
    <div onClick={handleClick}>
      <h1>{fullName}</h1>
      <ul>
        {activeItems.map(item => <li key={item.id}>{item.name}</li>)}
      </ul>
    </div>
  );
}
```

```tsx
// ✅ CORRECT: No memoization needed
function UserProfile({ user }: { user: User }) {
  const fullName = `${user.firstName} ${user.lastName}`;
  const activeItems = user.items.filter(i => i.active);

  return (
    <div onClick={() => console.log('clicked')}>
      <h1>{fullName}</h1>
      <ul>
        {activeItems.map(item => <li key={item.id}>{item.name}</li>)}
      </ul>
    </div>
  );
}
```

### When useCallback IS Needed

Only when passing to memoized children:

```tsx
// ✅ useCallback needed: Child uses React.memo
const MemoizedList = memo(function ItemList({
  items,
  onSelect
}: Props) {
  return (
    <ul>
      {items.map(item => (
        <li key={item.id} onClick={() => onSelect(item.id)}>
          {item.name}
        </li>
      ))}
    </ul>
  );
});

function Parent({ items }: { items: Item[] }) {
  const [selected, setSelected] = useState<string | null>(null);

  // Needed: prevents MemoizedList re-render
  const handleSelect = useCallback((id: string) => {
    setSelected(id);
  }, []);

  return <MemoizedList items={items} onSelect={handleSelect} />;
}
```

## Pattern 5: Data Fetching Anti-Pattern

### Problem: Manual useEffect for Data Fetching

```tsx
// ❌ PROBLEMATIC: Missing loading/error, race conditions, no cache
function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetchUser(userId).then(setUser);
  }, [userId]);

  if (!user) return null;
  return <div>{user.name}</div>;
}
```

```tsx
// ❌ BETTER but still problematic: Cleanup doesn't prevent state update
function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchUser(userId)
      .then(data => {
        if (!cancelled) {
          setUser(data);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [userId]);

  if (loading) return <Spinner />;
  if (error) return <Error message={error.message} />;
  if (!user) return null;
  return <div>{user.name}</div>;
}
```

### Solution: Use Data Fetching Library

```tsx
// ✅ CORRECT: Use TanStack Query, SWR, or similar
import { useQuery } from '@tanstack/react-query';

function UserProfile({ userId }: { userId: string }) {
  const { data: user, isLoading, error } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetchUser(userId),
  });

  if (isLoading) return <Spinner />;
  if (error) return <Error message={error.message} />;
  if (!user) return null;
  return <div>{user.name}</div>;
}
```

## Refactoring Decision Tree

```
Is this value derived from props/state?
├── YES → Calculate during render (no hooks)
│
Is this responding to a user action?
├── YES → Handle in event handler (no useEffect)
│
Is this syncing with an external system?
├── YES → Consider if a library handles it better
│   ├── Data fetching → Use React Query/SWR
│   ├── Form state → Use React Hook Form
│   └── Animation → Use Framer Motion
│
Is this computation expensive?
├── NO → Skip useMemo
├── YES → Profile first
│   └── Confirmed slow → Add useMemo
│
Is this callback passed to React.memo child?
├── NO → Skip useCallback
└── YES → Add useCallback
```

## Code Smell Detection

Watch for these patterns in code review:

| Code Smell | Usually Indicates |
|------------|-------------------|
| `useState` + `useEffect` updating same value | Derived state anti-pattern |
| `useEffect` with `setState` inside | Possibly event-driven logic |
| `useEffect` watching props, setting state | Props-to-state sync issue |
| `useMemo` returning primitive | Unnecessary memoization |
| `useCallback` not passed to child | Unnecessary memoization |
| Multiple `useState` for related data | Consider useReducer or object |
| `useEffect` with `[]` deps and fetch | Use data fetching library |

## Summary

Before adding any hook, ask:

1. **Can this be calculated during render?** → Skip hooks entirely
2. **Should this be in an event handler?** → Move logic there
3. **Is a library better suited?** → Use it
4. **Is this truly performance-critical?** → Profile first
5. **Does the child need stable references?** → Only then memoize
