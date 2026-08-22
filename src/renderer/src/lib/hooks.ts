/**
 * 汎用フック群
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.getAttribute("aria-hidden") !== "true");
}

/**
 * モーダル表示中、Tab キーでのフォーカス移動をコンテナ内に閉じ込め、
 * 表示直後はコンテナ内にフォーカスが無ければ先頭要素へ移す。
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    if (!container.contains(document.activeElement)) {
      getFocusableElements(container)[0]?.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (activeElement === first || !container.contains(activeElement)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (activeElement === last || !container.contains(activeElement)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, containerRef]);
}

/** 値の変更を指定ミリ秒遅延させて反映する */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface IncrementalRenderResult {
  /** 現在描画済みの件数 */
  count: number;
  /** リスト末尾に配置するセンチネル要素の ref */
  sentinelRef: RefObject<HTMLDivElement | null>;
  /** 指定 index が描画されるよう件数を拡張する（キーボード移動用） */
  ensure: (index: number) => void;
}

/**
 * IntersectionObserver による段階描画。
 * スクロールでセンチネルが見えたら batchSize ずつ描画件数を増やす。
 */
export function useIncrementalRender(
  total: number,
  batchSize = 50,
  rootMargin = "300px",
): IncrementalRenderResult {
  const [count, setCount] = useState(() => Math.min(batchSize, total));
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 総数の変化（フィルタ変更など）に追従してクランプ
  useEffect(() => {
    setCount((current) => Math.min(Math.max(current, batchSize), Math.max(total, batchSize)));
  }, [total, batchSize]);

  const ensure = useCallback(
    (index: number) => {
      setCount((current) => Math.max(current, Math.min(index + batchSize, total)));
    },
    [batchSize, total],
  );

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || count >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setCount((current) => Math.min(current + batchSize, total));
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [count, total, batchSize, rootMargin]);

  return { count, sentinelRef, ensure };
}

/** localStorage の値を React state として扱う（書き込みも同期） */
export function useStoredState<T extends string>(
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? defaultValue : (stored as T);
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      localStorage.setItem(key, next);
    },
    [key],
  );
  return [value, update];
}
