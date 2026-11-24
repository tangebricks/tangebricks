import type { Config } from "tailwindcss";

export const STUDIO_DESIGN_TOKENS = {
  colors: {
    "surface-base": "#020617",
    "surface-canvas": "#090d16",
    "surface-raised": "#0f172a",
    "surface-control": "#1e293b",
    border: "#1e293b",
    "border-strong": "#334155",
    "text-primary": "#f1f5f9",
    "text-secondary": "#cbd5e1",
    "text-muted": "#94a3b8",
    "text-on-accent": "#020617",
    accent: "#f59e0b",
    "accent-hover": "#fbbf24",
    success: "#10b981",
    "success-text": "#34d399",
    info: "#38bdf8",
  },
  spacing: {
    base: "4px",
    "topbar-height": "56px",
    "left-panel-width": "256px",
    "canvas-grid": "22px",
  },
  borderRadius: {
    sm: "4px",
    md: "6px",
    lg: "8px",
    xl: "12px",
    full: "9999px",
  },
  fontFamily: {
    sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
    mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
  },
};

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: STUDIO_DESIGN_TOKENS.colors,
      spacing: STUDIO_DESIGN_TOKENS.spacing,
      borderRadius: STUDIO_DESIGN_TOKENS.borderRadius,
      fontFamily: STUDIO_DESIGN_TOKENS.fontFamily,
    },
  },
  plugins: [],
};

export default config;
