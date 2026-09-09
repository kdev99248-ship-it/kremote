/**
 * Notification plumbing for "command finished" on long-running commands.
 *
 * Permissions: asked lazily and only when the user turns the bell on - never
 * on page load (browsers punish permission prompts that aren't user-gestured,
 * and users hate it). Denial is remembered so we don't re-ask forever.
 *
 * Delivery: only fire when the page is hidden OR the finished terminal isn't
 * the focused one - if you're watching the terminal, a notification is noise.
 * Click focuses the app and the right terminal tab.
 */

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

const PREF_KEY = 'kremote.notify';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function readPref(): boolean {
  try { return localStorage.getItem(PREF_KEY) === 'on'; } catch { return false; }
}

export function writePref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, 'on');
    else localStorage.removeItem(PREF_KEY);
  } catch { /* private mode */ }
}

/** Ask (if needed) and persist the preference. Returns whether notifications
 *  are actually usable after the call. */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; }
  }
  const ok = perm === 'granted';
  writePref(ok);
  return ok;
}

export function disableNotifications(): void {
  writePref(false);
}

/** Should a finished command surface right now? Quiet when the user is
 *  already looking at that terminal. */
export function shouldNotify(tabFocused: boolean): boolean {
  return document.hidden || !tabFocused;
}

/** Fire the notification. Resolves with the notification title for tests. */
export function showFinishedNotification(opts: {
  title: string;
  body: string;
  onClick: () => void;
}): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: 'kremote-cmd-done',        // replace, don't stack
      renotify: true,
      silent: false,
    });
    n.addEventListener('click', () => {
      try { n.close(); } catch { /* already closed */ }
      opts.onClick();
    });
  } catch { /* notification failed - non-fatal by design */ }
}
