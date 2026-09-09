/**
 * Terminal settings (persisted in localStorage): font size and theme.
 * Kept deliberately tiny — these are the two knobs that matter on a phone.
 */

const KEY = 'kremote.term.settings';

export interface TermSettings {
  fontSize: number;       // px, clamped 10–24
  theme: 'dark' | 'light';
}

export const DEFAULT_SETTINGS: TermSettings = { fontSize: 14, theme: 'dark' };

export function readSettings(): TermSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const v = JSON.parse(raw);
    return {
      fontSize: clampNum(v?.fontSize, DEFAULT_SETTINGS.fontSize, 10, 24),
      theme: v?.theme === 'light' ? 'light' : 'dark',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(s: TermSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

/** xterm theme colors — shared with createTab(). Light theme is a soft paper
 *  look with the same coral cursor so the app identity survives. */
export const TERM_THEMES: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    background: '#040404',
    foreground: '#e5e5e5',
    cursor: '#e46c4c',
    cursorAccent: '#0c0c0c',
    selectionBackground: 'rgba(228, 108, 76, .28)',
    selectionInactiveBackground: 'rgba(228, 108, 76, .14)',
    black: '#242424', red: '#ff5f57', green: '#22c55e', yellow: '#febc2e',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e5e5',
    brightBlack: '#737373', brightRed: '#ff8178', brightGreen: '#4ade80',
    brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9', brightWhite: '#fafafa',
  },
  light: {
    background: '#faf6f2',
    foreground: '#2c2620',
    cursor: '#c4563a',
    cursorAccent: '#faf6f2',
    selectionBackground: 'rgba(196, 86, 58, .25)',
    selectionInactiveBackground: 'rgba(196, 86, 58, .12)',
    black: '#3a332c', red: '#c0392b', green: '#1e8449', yellow: '#b9770e',
    blue: '#2471a3', magenta: '#8e44ad', cyan: '#148f77', white: '#5d574f',
    brightBlack: '#7a736a', brightRed: '#cd6155', brightGreen: '#58d68d',
    brightYellow: '#f4d03f', brightBlue: '#5dade2', brightMagenta: '#af7ac5',
    brightCyan: '#48c9b0', brightWhite: '#2c2620',
  },
};

function clampNum(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}
