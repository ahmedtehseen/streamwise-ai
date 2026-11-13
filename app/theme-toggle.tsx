"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ThemePreference = "light" | "dark";
const THEME_KEY = "streamwise-color-theme";

function applyTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference | null>(null);
  const transitionTimer = useRef<number | null>(null);

  const changeTheme = useCallback((nextTheme: ThemePreference, persist = false) => {
    const root = document.documentElement;
    root.classList.add("theme-changing");
    setTheme(nextTheme);
    applyTheme(nextTheme);
    if (persist) {
      try { window.localStorage.setItem(THEME_KEY, nextTheme); } catch { /* Theme still changes for this visit. */ }
    }
    if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
    transitionTimer.current = window.setTimeout(() => {
      root.classList.remove("theme-changing");
      transitionTimer.current = null;
    }, 260);
  }, []);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    let savedTheme: string | null = null;
    try { savedTheme = window.localStorage.getItem(THEME_KEY); } catch { /* Use the system preference when storage is unavailable. */ }
    const initialTheme = savedTheme === "dark" || savedTheme === "light"
      ? savedTheme
      : systemTheme.matches ? "dark" : "light";
    setTheme(initialTheme);
    applyTheme(initialTheme);

    const followSystem = (event: MediaQueryListEvent) => {
      try { if (window.localStorage.getItem(THEME_KEY)) return; } catch { /* Continue following the system preference. */ }
      changeTheme(event.matches ? "dark" : "light");
    };
    systemTheme.addEventListener("change", followSystem);
    return () => {
      systemTheme.removeEventListener("change", followSystem);
      if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
    };
  }, [changeTheme]);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    changeTheme(nextTheme, true);
  }

  return (
    <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
      <span className="theme-toggle-icon" aria-hidden="true">{theme === "dark" ? "☼" : "◐"}</span>
      <span>{theme === null ? "Theme" : theme === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}
