import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { money, moneyCompact, num, percent, formatDate, formatDateFull, formatDateTime, type Lang } from "./format";

export type ThemeChoice = "system" | "light" | "dark" | "brand";
export type { Lang };

type Settings = {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  /** Desktop sidebar collapsed to an icon-only rail. */
  navCollapsed: boolean;
  toggleNav: () => void;
  /** Interface language. Also switches numerals and date formats. */
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Formatters bound to the active language. The app is BDT only. */
  fmt: (value: number) => string;
  fmtCompact: (value: number) => string;
  fmtNum: (value: number) => string;
  fmtPercent: (fraction: number) => string;
  fmtDate: (ts: number) => string;
  fmtDateFull: (ts: number) => string;
  fmtDateTime: (ts: number) => string;
};

const SettingsContext = createContext<Settings | null>(null);

const THEME_KEY = "ac.theme";
const NAV_KEY = "ac.navCollapsed";
const LANG_KEY = "ac.lang";

function readTheme(): ThemeChoice {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" || raw === "brand" ? raw : "system";
}

function readNavCollapsed(): boolean {
  return localStorage.getItem(NAV_KEY) === "1";
}

function readLang(): Lang {
  return localStorage.getItem(LANG_KEY) === "bn" ? "bn" : "en";
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme);
  const [navCollapsed, setNavCollapsed] = useState<boolean>(readNavCollapsed);
  const [lang, setLangState] = useState<Lang>(readLang);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem(LANG_KEY, next);
    document.documentElement.lang = next;
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const toggleNav = useCallback(() => {
    setNavCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(NAV_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const value = useMemo<Settings>(
    () => ({
      theme,
      setTheme,
      navCollapsed,
      toggleNav,
      lang,
      setLang,
      fmt: (v: number) => money(v, lang),
      fmtCompact: (v: number) => moneyCompact(v, lang),
      fmtNum: (v: number) => num(v, lang),
      fmtPercent: (f: number) => percent(f, lang),
      fmtDate: (ts: number) => formatDate(ts, lang),
      fmtDateFull: (ts: number) => formatDateFull(ts, lang),
      fmtDateTime: (ts: number) => formatDateTime(ts, lang),
    }),
    [theme, setTheme, navCollapsed, toggleNav, lang, setLang],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
