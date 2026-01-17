/**
 * React Hooks Best Practices - Good Patterns
 *
 * This file demonstrates correct usage of React hooks following
 * the principle: "The best hook is the one you don't need to write."
 */

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  memo,
  type ReactNode,
} from 'react';

// =============================================================================
// Pattern 1: Derived State - Calculate During Render
// =============================================================================

interface Product {
  id: string;
  name: string;
  price: number;
  quantity: number;
  isActive: boolean;
}

interface CartProps {
  products: Product[];
}

/**
 * ✅ GOOD: All derived values calculated during render
 * - No useState for computed values
 * - No useEffect to sync state
 * - Values always consistent with source data
 */
export function Cart({ products }: CartProps) {
  // Derived values - just calculate them
  const activeProducts = products.filter((p) => p.isActive);
  const itemCount = activeProducts.length;
  const subtotal = activeProducts.reduce(
    (sum, p) => sum + p.price * p.quantity,
    0
  );
  const tax = subtotal * 0.1;
  const total = subtotal + tax;
  const hasDiscount = total > 100;

  return (
    <div>
      <h2>Cart ({itemCount} items)</h2>
      <p>Subtotal: ${subtotal.toFixed(2)}</p>
      <p>Tax: ${tax.toFixed(2)}</p>
      <p>Total: ${total.toFixed(2)}</p>
      {hasDiscount && <p>🎉 Free shipping applied!</p>}
    </div>
  );
}

// =============================================================================
// Pattern 2: Event Handlers Instead of Effects
// =============================================================================

interface SearchFormProps {
  onResults: (results: string[]) => void;
}

/**
 * ✅ GOOD: All logic in event handler
 * - Analytics tracked at the moment of action
 * - Fetch triggered directly by user action
 * - No effect chains or race conditions
 */
export function SearchForm({ onResults }: SearchFormProps) {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!query.trim()) return;

    // Analytics at point of action
    console.log('Search submitted:', query);

    setIsLoading(true);

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const results = await response.json();
      onResults(results);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search..."
        disabled={isLoading}
      />
      <button type="submit" disabled={isLoading}>
        {isLoading ? 'Searching...' : 'Search'}
      </button>
    </form>
  );
}

// =============================================================================
// Pattern 3: Key-Based Reset Instead of Props Sync
// =============================================================================

interface EditableFieldProps {
  initialValue: string;
  onSave: (value: string) => void;
}

/**
 * ✅ GOOD: Uses key for reset, no props-to-state sync
 * Parent usage: <EditableField key={recordId} initialValue={record.name} />
 */
export function EditableField({ initialValue, onSave }: EditableFieldProps) {
  const [value, setValue] = useState(initialValue);
  const [isDirty, setIsDirty] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    setIsDirty(true);
  };

  const handleSave = () => {
    if (isDirty) {
      onSave(value);
      setIsDirty(false);
    }
  };

  return (
    <div>
      <input value={value} onChange={handleChange} onBlur={handleSave} />
      {isDirty && <span>(unsaved)</span>}
    </div>
  );
}

// =============================================================================
// Pattern 4: Strategic Memoization (Only When Needed)
// =============================================================================

interface DataTableProps {
  data: Array<{ id: string; name: string; value: number }>;
  sortKey: 'name' | 'value';
  sortDirection: 'asc' | 'desc';
  onRowClick: (id: string) => void;
}

/**
 * ✅ GOOD: Memoization only for expensive operations
 * - useMemo for O(n log n) sort on large dataset
 * - useCallback for callback passed to memoized child
 * - React.memo on child that receives callback
 */
export function DataTable({
  data,
  sortKey,
  sortDirection,
  onRowClick,
}: DataTableProps) {
  // ✅ Expensive sort operation - worth memoizing
  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      const comparison =
        typeof aVal === 'string' ? aVal.localeCompare(bVal as string) : aVal - (bVal as number);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [data, sortKey, sortDirection]);

  // ✅ Callback for memoized child
  const handleRowClick = useCallback(
    (id: string) => {
      onRowClick(id);
    },
    [onRowClick]
  );

  return (
    <table>
      <tbody>
        {sortedData.map((row) => (
          <MemoizedRow key={row.id} row={row} onClick={handleRowClick} />
        ))}
      </tbody>
    </table>
  );
}

interface RowProps {
  row: { id: string; name: string; value: number };
  onClick: (id: string) => void;
}

const MemoizedRow = memo(function Row({ row, onClick }: RowProps) {
  return (
    <tr onClick={() => onClick(row.id)}>
      <td>{row.name}</td>
      <td>{row.value}</td>
    </tr>
  );
});

// =============================================================================
// Pattern 5: Legitimate useEffect for External Systems
// =============================================================================

interface MapProps {
  center: { lat: number; lng: number };
  zoom: number;
}

/**
 * ✅ GOOD: useEffect for external system synchronization
 * - Map library is external to React
 * - Cleanup properly destroys the instance
 * - Effect only re-runs when dependencies change
 */
export function Map({ center, zoom }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<unknown>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize external library
    // mapRef.current = new MapLibrary(containerRef.current, { center, zoom });

    return () => {
      // Cleanup external library
      // mapRef.current?.destroy();
    };
  }, []); // Empty deps: one-time initialization

  useEffect(() => {
    // Update external library when props change
    // mapRef.current?.setCenter(center);
    // mapRef.current?.setZoom(zoom);
  }, [center, zoom]);

  return <div ref={containerRef} style={{ width: '100%', height: '400px' }} />;
}

// =============================================================================
// Pattern 6: Composition of Simple Custom Hooks
// =============================================================================

/**
 * ✅ GOOD: Simple, focused custom hook
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

/**
 * ✅ GOOD: Composed from simpler hooks
 */
export function useDebouncedSearch(searchTerm: string) {
  const [results, setResults] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const debouncedTerm = useDebounce(searchTerm, 300);

  useEffect(() => {
    if (!debouncedTerm) {
      setResults([]);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    fetch(`/api/search?q=${encodeURIComponent(debouncedTerm)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setResults(data);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedTerm]);

  return {
    results,
    isLoading,
    isDebouncing: searchTerm !== debouncedTerm,
  };
}

// =============================================================================
// Pattern 7: Proper Ref Usage for Latest Values
// =============================================================================

interface IntervalCounterProps {
  step: number;
}

/**
 * ✅ GOOD: useRef for "latest value" without re-running effect
 */
export function IntervalCounter({ step }: IntervalCounterProps) {
  const [count, setCount] = useState(0);
  const stepRef = useRef(step);

  // Keep ref in sync
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // Interval doesn't need to restart when step changes
  useEffect(() => {
    const timer = setInterval(() => {
      setCount((c) => c + stepRef.current);
    }, 1000);

    return () => clearInterval(timer);
  }, []); // Legitimately empty

  return (
    <div>
      Count: {count} (step: {step})
    </div>
  );
}
