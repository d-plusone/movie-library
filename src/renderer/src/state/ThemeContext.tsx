/**
 * テーマ管理（旧 Utils.ts ThemeManager の移植）
 * data-theme 属性 + プレースホルダー色の動的調整を担当する。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "dark";
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyThemeToBody(theme: Theme): void {
  const resolved = theme === "system" ? (prefersDark() ? "dark" : "light") : theme;
  document.body.setAttribute("data-theme", resolved);
}

function updatePlaceholderColors(theme: Theme): void {
  const isDark =
    theme === "dark" || (theme === "system" && prefersDark());
  const placeholderColor = isDark ? "#666" : "#999";

  let style = document.getElementById("dynamic-placeholder-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "dynamic-placeholder-styles";
    document.head.appendChild(style);
  }
  style.textContent = `input::placeholder, textarea::placeholder { color: ${placeholderColor} !important; }`;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  const applyTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem("theme", next);
    applyThemeToBody(next);
    updatePlaceholderColors(next);
  }, []);

  const setTheme = useCallback((next: Theme) => applyTheme(next), [applyTheme]);

  // 初回適用
  useEffect(() => {
    applyThemeToBody(theme);
    updatePlaceholderColors(theme);
  }, [theme]);

  // システムテーマ追従
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyThemeToBody("system");
      updatePlaceholderColors("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggleTheme: () =>
        applyTheme(theme === "dark" ? "light" : "dark"),
    }),
    [theme, setTheme, applyTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
