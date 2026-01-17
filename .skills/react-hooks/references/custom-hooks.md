# Custom Hook Design Patterns

This reference provides comprehensive guidance for designing reusable, composable custom hooks.

## Design Principles

### 1. Single Responsibility

Each hook should encapsulate one concern:

```tsx
// ❌ WRONG: Multiple unrelated concerns
function useUserData(userId: string) {
  const [user, setUser] = useState<User | null>(null);
  const [theme, setTheme] = useState('light');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  // ... mixed logic for user, theme, and notifications
}

// ✅ CORRECT: Separate concerns
function useUser(userId: string) { /* user fetching logic */ }
function useTheme() { /* theme logic */ }
function useNotifications() { /* notification logic */ }
```

### 2. Minimal API Surface

Expose only what consumers need:

```tsx
// ❌ WRONG: Exposes internal implementation
function useCounter() {
  const [count, setCount] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [lastAction, setLastAction] = useState<'inc' | 'dec' | null>(null);

  return {
    count,
    setCount,        // Exposes raw setter
    history,         // Internal detail
    setHistory,      // Internal detail
    lastAction,      // Internal detail
    setLastAction,   // Internal detail
  };
}

// ✅ CORRECT: Clean, minimal API
function useCounter(initial = 0) {
  const [count, setCount] = useState(initial);

  const increment = useCallback(() => setCount(c => c + 1), []);
  const decrement = useCallback(() => setCount(c => c - 1), []);
  const reset = useCallback(() => setCount(initial), [initial]);

  return { count, increment, decrement, reset };
}
```

### 3. Predictable Return Types

Choose return type based on usage pattern:

| Pattern | Structure | Use Case |
|---------|-----------|----------|
| Tuple | `[value, setter]` | State-like APIs |
| Object | `{ data, error, loading }` | Multiple related values |
| Single Value | `value` | Derived/computed values |

```tsx
// Tuple: mirrors useState API
function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : initial;
  });

  const setStoredValue = useCallback((newValue: T) => {
    setValue(newValue);
    localStorage.setItem(key, JSON.stringify(newValue));
  }, [key]);

  return [value, setStoredValue];
}

// Object: multiple related states
interface UseAsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  execute: () => Promise<void>;
}

function useAsync<T>(asyncFn: () => Promise<T>): UseAsyncState<T> {
  const [state, setState] = useState<{
    data: T | null;
    error: Error | null;
    loading: boolean;
  }>({
    data: null,
    error: null,
    loading: false,
  });

  const execute = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await asyncFn();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState(s => ({ ...s, error: error as Error, loading: false }));
    }
  }, [asyncFn]);

  return { ...state, execute };
}

// Single value: computed result
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    window.matchMedia(query).matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
```

## Composition Patterns

### Building Complex Hooks from Simple Ones

```tsx
// Base hooks
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

function useFetch<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!url) return;

    let cancelled = false;
    setLoading(true);

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (!cancelled) {
          setData(data);
          setLoading(false);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setError(error);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [url]);

  return { data, loading, error };
}

// Composed hook
function useDebouncedSearch<T>(searchTerm: string, baseUrl: string) {
  const debouncedTerm = useDebounce(searchTerm, 300);
  const url = debouncedTerm ? `${baseUrl}?q=${encodeURIComponent(debouncedTerm)}` : null;
  const { data, loading, error } = useFetch<T>(url);

  return {
    results: data,
    loading,
    error,
    isDebouncing: searchTerm !== debouncedTerm,
  };
}
```

### Hook Factories

Create parameterized hooks for similar patterns:

```tsx
// Factory for storage hooks
function createStorageHook(storage: Storage) {
  return function useStorage<T>(key: string, initial: T): [T, (value: T) => void] {
    const [value, setValue] = useState<T>(() => {
      try {
        const item = storage.getItem(key);
        return item ? JSON.parse(item) : initial;
      } catch {
        return initial;
      }
    });

    const setStoredValue = useCallback((newValue: T) => {
      setValue(newValue);
      storage.setItem(key, JSON.stringify(newValue));
    }, [key]);

    return [value, setStoredValue];
  };
}

// Usage
const useLocalStorage = createStorageHook(localStorage);
const useSessionStorage = createStorageHook(sessionStorage);
```

### Reducer-Based Complex State

For complex state transitions:

```tsx
interface FormState<T> {
  values: T;
  errors: Partial<Record<keyof T, string>>;
  touched: Partial<Record<keyof T, boolean>>;
  isSubmitting: boolean;
  isValid: boolean;
}

type FormAction<T> =
  | { type: 'SET_VALUE'; field: keyof T; value: T[keyof T] }
  | { type: 'SET_ERROR'; field: keyof T; error: string }
  | { type: 'TOUCH'; field: keyof T }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_END' }
  | { type: 'RESET'; values: T };

function createFormReducer<T>() {
  return function formReducer(
    state: FormState<T>,
    action: FormAction<T>
  ): FormState<T> {
    switch (action.type) {
      case 'SET_VALUE':
        return {
          ...state,
          values: { ...state.values, [action.field]: action.value },
        };
      case 'SET_ERROR':
        return {
          ...state,
          errors: { ...state.errors, [action.field]: action.error },
        };
      case 'TOUCH':
        return {
          ...state,
          touched: { ...state.touched, [action.field]: true },
        };
      case 'SUBMIT_START':
        return { ...state, isSubmitting: true };
      case 'SUBMIT_END':
        return { ...state, isSubmitting: false };
      case 'RESET':
        return {
          values: action.values,
          errors: {},
          touched: {},
          isSubmitting: false,
          isValid: true,
        };
      default:
        return state;
    }
  };
}

function useForm<T extends Record<string, unknown>>(initialValues: T) {
  const [state, dispatch] = useReducer(
    createFormReducer<T>(),
    {
      values: initialValues,
      errors: {},
      touched: {},
      isSubmitting: false,
      isValid: true,
    }
  );

  const setValue = useCallback(<K extends keyof T>(field: K, value: T[K]) => {
    dispatch({ type: 'SET_VALUE', field, value });
  }, []);

  const setError = useCallback((field: keyof T, error: string) => {
    dispatch({ type: 'SET_ERROR', field, error });
  }, []);

  const touch = useCallback((field: keyof T) => {
    dispatch({ type: 'TOUCH', field });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET', values: initialValues });
  }, [initialValues]);

  return {
    ...state,
    setValue,
    setError,
    touch,
    reset,
  };
}
```

## Event and Subscription Patterns

### Event Listener Hook

```tsx
function useEventListener<K extends keyof WindowEventMap>(
  eventName: K,
  handler: (event: WindowEventMap[K]) => void,
  element: Window | HTMLElement | null = window
) {
  const savedHandler = useRef(handler);

  useEffect(() => {
    savedHandler.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!element) return;

    const eventListener = (event: Event) => {
      savedHandler.current(event as WindowEventMap[K]);
    };

    element.addEventListener(eventName, eventListener);
    return () => element.removeEventListener(eventName, eventListener);
  }, [eventName, element]);
}
```

### External Store Subscription

```tsx
function useExternalStore<T>(
  subscribe: (callback: () => void) => () => void,
  getSnapshot: () => T
): T {
  const [state, setState] = useState(getSnapshot);

  useEffect(() => {
    const handleChange = () => setState(getSnapshot());
    const unsubscribe = subscribe(handleChange);
    // Sync in case store changed between render and effect
    handleChange();
    return unsubscribe;
  }, [subscribe, getSnapshot]);

  return state;
}

// Usage with external store
const useRouterLocation = () => useExternalStore(
  (callback) => {
    window.addEventListener('popstate', callback);
    return () => window.removeEventListener('popstate', callback);
  },
  () => window.location.pathname
);
```

## Testing Custom Hooks

### Using @testing-library/react-hooks

```tsx
import { renderHook, act } from '@testing-library/react';

describe('useCounter', () => {
  it('increments counter', () => {
    const { result } = renderHook(() => useCounter(0));

    expect(result.current.count).toBe(0);

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
  });

  it('resets to initial value', () => {
    const { result } = renderHook(() => useCounter(5));

    act(() => {
      result.current.increment();
      result.current.increment();
    });

    expect(result.current.count).toBe(7);

    act(() => {
      result.current.reset();
    });

    expect(result.current.count).toBe(5);
  });
});
```

### Testing Async Hooks

```tsx
describe('useAsync', () => {
  it('handles successful async operation', async () => {
    const mockFn = jest.fn().mockResolvedValue('data');
    const { result } = renderHook(() => useAsync(mockFn));

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe(null);

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('data');
    expect(result.current.error).toBe(null);
  });

  it('handles errors', async () => {
    const error = new Error('Failed');
    const mockFn = jest.fn().mockRejectedValue(error);
    const { result } = renderHook(() => useAsync(mockFn));

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe(null);
    expect(result.current.error).toBe(error);
  });
});
```

## Common Custom Hook Recipes

### useToggle

```tsx
function useToggle(initial = false): [boolean, () => void] {
  const [value, setValue] = useState(initial);
  const toggle = useCallback(() => setValue(v => !v), []);
  return [value, toggle];
}
```

### usePrevious

```tsx
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>();

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref.current;
}
```

### useOnClickOutside

```tsx
function useOnClickOutside<T extends HTMLElement>(
  ref: RefObject<T>,
  handler: (event: MouseEvent | TouchEvent) => void
) {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) {
        return;
      }
      handler(event);
    };

    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);

    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler]);
}
```

### useInterval

```tsx
function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;

    const id = setInterval(() => savedCallback.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}
```

## Anti-Patterns to Avoid

### 1. Returning Unstable References

```tsx
// ❌ WRONG: Returns new object every render
function useUser(id: string) {
  const [user, setUser] = useState<User | null>(null);

  return {
    user,
    refresh: () => fetchUser(id).then(setUser), // New function each render
  };
}

// ✅ CORRECT: Stable references
function useUser(id: string) {
  const [user, setUser] = useState<User | null>(null);

  const refresh = useCallback(() => {
    fetchUser(id).then(setUser);
  }, [id]);

  return { user, refresh };
}
```

### 2. Implicit Dependencies

```tsx
// ❌ WRONG: Uses external variable without declaring dependency
let globalConfig: Config;

function useConfig() {
  return useMemo(() => processConfig(globalConfig), []); // Missing globalConfig
}

// ✅ CORRECT: Explicit dependencies
function useConfig(config: Config) {
  return useMemo(() => processConfig(config), [config]);
}
```

### 3. Side Effects in Render

```tsx
// ❌ WRONG: Side effect during render
function useAnalytics(event: string) {
  analytics.track(event); // Called on every render!
  return null;
}

// ✅ CORRECT: Side effect in useEffect
function useAnalytics(event: string) {
  useEffect(() => {
    analytics.track(event);
  }, [event]);
}
```

## Summary

Effective custom hooks:

1. **Do one thing well** - Single responsibility
2. **Hide implementation** - Minimal API surface
3. **Compose naturally** - Build from smaller hooks
4. **Return stable values** - Memoize where needed
5. **Handle cleanup** - Proper effect cleanup
6. **Are testable** - Isolate logic from components
