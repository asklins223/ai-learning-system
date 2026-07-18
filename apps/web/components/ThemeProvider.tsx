"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";

type Theme = "day" | "night";
type ThemeOrigin = { x: number; y: number };

interface ThemeContextType {
  theme: Theme;
  toggleTheme: (origin?: ThemeOrigin) => void;
  setTheme: (theme: Theme) => void;
  isTransitioning: boolean;
  mounted: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = "ailearn.theme";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "day";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (stored === "day" || stored === "night") return stored;
  } catch {
    // Restricted storage must not prevent the application from rendering.
  }
  return "day";
}

// Script to prevent flash of wrong theme - runs before React hydration.
// F-030: Only set data-theme on <html> to avoid body class hydration mismatch.
// Body classes are managed by React after mount via useEffect.
const themeScript = `
  (function() {
    var theme = "day";
    try { theme = localStorage.getItem("${STORAGE_KEY}") || "day"; } catch (_) {}
    document.documentElement.setAttribute("data-theme", theme === "night" ? "night" : "day");
  })();
`;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("day");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<Theme | null>(null);
  const [mounted, setMounted] = useState(false);
  const timersRef = useRef<number[]>([]);

  const clearTransitionTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const clearTransitionMarker = useCallback(() => {
    document.documentElement.removeAttribute("data-theme-transitioning");
  }, []);

  const clearThemeTransition = useCallback(() => {
    clearTransitionTimers();
    clearTransitionMarker();
  }, [clearTransitionMarker, clearTransitionTimers]);

  useEffect(() => {
    // A previous hot reload or interrupted transition must never leave the
    // expensive descendant colour transitions enabled.
    clearThemeTransition();

    // Get theme immediately to prevent flash.
    const initialTheme = getInitialTheme();
    setThemeState(initialTheme);
    setMounted(true);

    return clearThemeTransition;
  }, [clearThemeTransition]);

  useEffect(() => {
    if (!mounted) return;

    // Apply theme to document
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // The in-memory theme still works when persistent storage is denied.
    }

  }, [theme, mounted]);

  const setTheme = useCallback((newTheme: Theme) => {
    clearThemeTransition();
    setTransitionTarget(null);
    setIsTransitioning(false);
    setThemeState(newTheme);
  }, [clearThemeTransition]);

  const toggleTheme = useCallback((origin?: ThemeOrigin) => {
    if (!mounted || isTransitioning) return;

    const nextTheme = theme === "day" ? "night" : "day";
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (prefersReducedMotion) {
      clearThemeTransition();
      setTransitionTarget(null);
      setIsTransitioning(false);
      setThemeState(nextTheme);
      return;
    }

    const x = origin?.x ?? window.innerWidth - 40;
    const y = origin?.y ?? 40;
    document.documentElement.style.setProperty("--reveal-x", `${x}px`);
    document.documentElement.style.setProperty("--reveal-y", `${y}px`);

    clearThemeTransition();
    document.documentElement.setAttribute("data-theme-transitioning", "true");
    setIsTransitioning(true);
    setTransitionTarget(nextTheme);
    timersRef.current = [
      window.setTimeout(() => setThemeState(nextTheme), 430),
      window.setTimeout(() => {
        clearTransitionMarker();
        timersRef.current = [];
        setTransitionTarget(null);
        setIsTransitioning(false);
      }, 920),
    ];
  }, [
    clearThemeTransition,
    clearTransitionMarker,
    isTransitioning,
    mounted,
    theme,
  ]);

  // Listen for storage changes (sync across tabs)
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === "day" || e.newValue === "night")) {
        const newTheme = e.newValue;
        if (newTheme !== theme) {
          setTheme(newTheme);
        }
      }
    };
    
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [setTheme, theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, isTransitioning, mounted }}>
      {/* Inject script to prevent theme flash before hydration */}
      <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      {children}
      {mounted && transitionTarget && (
        <div
          className={`theme-reveal active to-${transitionTarget}`}
          aria-hidden="true"
        >
          <div className="reveal-ring" />
        </div>
      )}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
