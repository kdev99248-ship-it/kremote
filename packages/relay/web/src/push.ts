/**
 * Web Push (client side) for tail alerts (#3). The agent is the push *sender*;
 * here we just:
 *   1. register the service worker,
 *   2. ask the agent for its VAPID public key (push.config),
 *   3. subscribe the browser's push manager with it,
 *   4. hand the subscription back to the agent (push.subscribe).
 *
 * This lets tail pattern matches reach the phone even when the app is closed.
 * In-app notifications (notify.ts) still cover the case where the page is open.
 */

import { rpc, send } from './conn';

const PREF_KEY = 'kremote.push';

export function supportsPush(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && window.isSecureContext;
}

export function pushEnabledPref(): boolean {
  try { return localStorage.getItem(PREF_KEY) === 'on'; } catch { return false; }
}

function writePref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, 'on');
    else localStorage.removeItem(PREF_KEY);
  } catch { /* private mode */ }
}

/** urlBase64 → Uint8Array, the form applicationServerKey wants. */
function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Register SW, request permission, subscribe, and register with the agent.
 *  Returns whether push is active afterward. */
export async function enablePush(): Promise<boolean> {
  if (!supportsPush()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;

    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') { writePref(false); return false; }

    // Reuse an existing subscription if present; otherwise create one with the
    // agent's VAPID public key.
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const cfg = await rpc<{ ok: boolean; vapidPublicKey?: string }>({ type: 'push.config' });
      if (!cfg.ok || !cfg.vapidPublicKey) return false;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(cfg.vapidPublicKey),
      });
    }

    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
    const res = await rpc<{ ok: boolean }>({
      type: 'push.subscribe',
      sub: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    });
    writePref(res.ok);
    return res.ok;
  } catch {
    return false;
  }
}

/** Unsubscribe locally and tell the agent to drop the subscription. */
export async function disablePush(): Promise<void> {
  writePref(false);
  if (!supportsPush()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      send({ type: 'push.unsubscribe', endpoint });
    }
  } catch { /* best effort */ }
}
