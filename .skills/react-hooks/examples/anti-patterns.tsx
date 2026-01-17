/**
 * React Hooks Anti-Patterns
 *
 * This file demonstrates common mistakes with corrections.
 * Each section shows the wrong approach and the correct alternative.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';

// =============================================================================
// Anti-Pattern 1: Derived State with useState + useEffect
// =============================================================================

interface Item {
  id: string;
  price: number;
  quantity: number;
}

/**
 * ❌ WRONG: Storing derived state
 * Problems:
 * - Extra re-renders (first render + effect update)
 * - Potential for stale data between renders
 * - Unnecessary complexity
 */
function BadCart({ items }: { items: Item[] }) {
  const [total, setTotal] = useState(0);
  const [itemCount, setItemCount] = useState(0);

  useEffect(() => {
    setTotal(items.reduce((sum, i) => sum + i.price * i.quantity, 0));
    setItemCount(items.length);
  }, [items]);

  return (
    <div>
      {itemCount} items, total: ${total}
    </div>
  );
}

/**
 * ✅ CORRECT: Calculate during render
 */
function GoodCart({ items }: { items: Item[] }) {
  const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const itemCount = items.length;

  return (
    <div>
      {itemCount} items, total: ${total}
    </div>
  );
}

// =============================================================================
// Anti-Pattern 2: useEffect for Event Response
// =============================================================================

/**
 * ❌ WRONG: Effect chain for user action
 * Problems:
 * - Delayed response (waits for next render)
 * - Complex effect chains
 * - Race conditions possible
 */
function BadSearchForm() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);

  useEffect(() => {
    if (query) {
      // Analytics delayed until next render
      console.log('Search:', query);
      fetch(`/api/search?q=${query}`)
        .then((r) => r.json())
        .then(setResults);
    }
  }, [query]);

  return (
    <input value={query} onChange={(e) => setQuery(e.target.value)} />
  );
}

/**
 * ✅ CORRECT: Handle in event handler
 */
function GoodSearchForm() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuery = e.target.value;
    setQuery(newQuery);

    if (newQuery) {
      console.log('Search:', newQuery);
      const response = await fetch(`/api/search?q=${newQuery}`);
      setResults(await response.json());
    }
  };

  return <input value={query} onChange={handleChange} />;
}

// =============================================================================
// Anti-Pattern 3: Props-to-State Sync
// =============================================================================

interface EditorProps {
  initialContent: string;
  onSave: (content: string) => void;
}

/**
 * ❌ WRONG: Syncing props to state with useEffect
 * Problems:
 * - State can become stale
 * - Sync bugs when props change
 * - Extra render cycle
 */
function BadEditor({ initialContent, onSave }: EditorProps) {
  const [content, setContent] = useState(initialContent);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  return (
    <textarea
      value={content}
      onChange={(e) => setContent(e.target.value)}
      onBlur={() => onSave(content)}
    />
  );
}

/**
 * ✅ CORRECT: Use key in parent to reset
 * Parent: <GoodEditor key={documentId} initialContent={doc.content} />
 */
function GoodEditor({ initialContent, onSave }: EditorProps) {
  const [content, setContent] = useState(initialContent);
  // No useEffect needed - key handles reset

  return (
    <textarea
      value={content}
      onChange={(e) => setContent(e.target.value)}
      onBlur={() => onSave(content)}
    />
  );
}

// =============================================================================
// Anti-Pattern 4: Premature Memoization
// =============================================================================

interface User {
  firstName: string;
  lastName: string;
  items: Array<{ id: string; name: string; active: boolean }>;
}

/**
 * ❌ WRONG: Unnecessary memoization
 * Problems:
 * - useMemo/useCallback have overhead
 * - Makes code harder to read
 * - No actual performance benefit for cheap operations
 */
function BadUserProfile({ user }: { user: User }) {
  // ❌ String concatenation is cheap
  const fullName = useMemo(
    () => `${user.firstName} ${user.lastName}`,
    [user.firstName, user.lastName]
  );

  // ❌ Callback not passed to memoized child
  const handleClick = useCallback(() => {
    console.log('clicked');
  }, []);

  // ❌ Small array filter is cheap
  const activeItems = useMemo(
    () => user.items.filter((i) => i.active),
    [user.items]
  );

  return (
    <div onClick={handleClick}>
      <h1>{fullName}</h1>
      <ul>
        {activeItems.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * ✅ CORRECT: No unnecessary memoization
 */
function GoodUserProfile({ user }: { user: User }) {
  const fullName = `${user.firstName} ${user.lastName}`;
  const activeItems = user.items.filter((i) => i.active);

  return (
    <div onClick={() => console.log('clicked')}>
      <h1>{fullName}</h1>
      <ul>
        {activeItems.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// Anti-Pattern 5: useMemo for Constants
// =============================================================================

/**
 * ❌ WRONG: useMemo for constant values
 * Problems:
 * - Unnecessary hook call every render
 * - Misleading - suggests value might change
 */
function BadComponent() {
  // ❌ These never change, shouldn't use useMemo
  const options = useMemo(
    () => [
      { value: 'a', label: 'Option A' },
      { value: 'b', label: 'Option B' },
      { value: 'c', label: 'Option C' },
    ],
    []
  );

  const config = useMemo(
    () => ({
      timeout: 5000,
      retries: 3,
    }),
    []
  );

  return <Select options={options} />;
}

// ✅ CORRECT: Define constants at module level
const OPTIONS = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
  { value: 'c', label: 'Option C' },
] as const;

const CONFIG = {
  timeout: 5000,
  retries: 3,
} as const;

function GoodComponent() {
  // Just use the constants directly
  return <Select options={OPTIONS} />;
}

// Placeholder component
function Select({ options }: { options: readonly { value: string; label: string }[] }) {
  return (
    <select>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// =============================================================================
// Anti-Pattern 6: Suppressing ESLint Warnings
// =============================================================================

/**
 * ❌ WRONG: Suppressing exhaustive-deps warning
 * Problems:
 * - Stale closure bugs
 * - Hides real issues
 * - Effect doesn't re-run when it should
 */
function BadCounter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCount(count + 1); // Always uses initial count (0)!
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ❌ Suppressing warning about missing `count`

  return <div>{count}</div>;
}

/**
 * ✅ CORRECT: Use functional update to avoid dependency
 */
function GoodCounter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCount((c) => c + 1); // Functional update - no external dependency
    }, 1000);
    return () => clearInterval(timer);
  }, []); // Legitimately empty

  return <div>{count}</div>;
}

// =============================================================================
// Anti-Pattern 7: Unstable Custom Hook Returns
// =============================================================================

/**
 * ❌ WRONG: Custom hook returns unstable references
 * Problems:
 * - Consumers get new objects/functions every render
 * - Breaks memoization in consuming components
 * - Causes unnecessary re-renders
 */
function useBadData(id: string) {
  const [data, setData] = useState<unknown>(null);

  // ❌ New function every render
  const refresh = () => {
    fetch(`/api/data/${id}`)
      .then((r) => r.json())
      .then(setData);
  };

  // ❌ New object every render
  return {
    data,
    refresh,
    meta: { id, timestamp: Date.now() },
  };
}

/**
 * ✅ CORRECT: Custom hook returns stable references
 */
function useGoodData(id: string) {
  const [data, setData] = useState<unknown>(null);
  const [timestamp, setTimestamp] = useState<number | null>(null);

  // ✅ Stable callback
  const refresh = useCallback(() => {
    fetch(`/api/data/${id}`)
      .then((r) => r.json())
      .then((newData) => {
        setData(newData);
        setTimestamp(Date.now());
      });
  }, [id]);

  // ✅ Stable meta object (only changes when dependencies change)
  const meta = useMemo(() => ({ id, timestamp }), [id, timestamp]);

  return { data, refresh, meta };
}

// =============================================================================
// Anti-Pattern 8: Data Fetching in useEffect (Modern Alternative)
// =============================================================================

/**
 * ❌ PROBLEMATIC: Manual data fetching with useEffect
 * Problems:
 * - Race conditions with fast navigation
 * - No caching
 * - Repetitive loading/error state management
 * - No request deduplication
 */
function BadUserData({ userId }: { userId: string }) {
  const [user, setUser] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setUser(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  return <div>{JSON.stringify(user)}</div>;
}

/**
 * ✅ BETTER: Use data fetching library (TanStack Query, SWR, etc.)
 *
 * import { useQuery } from '@tanstack/react-query';
 *
 * function GoodUserData({ userId }: { userId: string }) {
 *   const { data: user, isLoading, error } = useQuery({
 *     queryKey: ['user', userId],
 *     queryFn: () => fetch(`/api/users/${userId}`).then(r => r.json()),
 *   });
 *
 *   if (isLoading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *   return <div>{JSON.stringify(user)}</div>;
 * }
 */

export {
  BadCart,
  GoodCart,
  BadSearchForm,
  GoodSearchForm,
  BadEditor,
  GoodEditor,
  BadUserProfile,
  GoodUserProfile,
  BadComponent,
  GoodComponent,
  BadCounter,
  GoodCounter,
  useBadData,
  useGoodData,
  BadUserData,
};
