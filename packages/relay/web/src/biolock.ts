/**
 * Biometric re-lock (#3): gate the stored session token behind WebAuthn
 * platform authenticators (Face ID / Touch / Windows Hello / Android
 * fingerprint). Opt-in from the settings popover.
 *
 * How it works:
 *  - Enabling creates a credential bound to this origin (kremote.cc).
 *  - The credential ID is stored in localStorage next to the session token.
 *  - On startup, if a session token + credential exist, the session token is
 *    withheld until `navigator.credentials.get()` resolves (user verified).
 *    Cancelled/failed verification → fall back to the ACCESS_KEY login.
 *
 * Nothing secret is stored — the WebAuthn assertion is used as a *local gate*
 * only; the session token itself is what authenticates to the relay. Someone
 * with the token but without the device still gets in, so this is a UX/
 * shoulder-surfing convenience layer, not a hard security boundary. (A hard
 * boundary would need server-side session revocation on unlock, which the
 * relay protocol does not have.)
 */

const CRED_KEY = 'kremote.webauthn.credId';

export function biolockSupported(): boolean {
  return typeof window !== 'undefined'
    && !!window.PublicKeyCredential
    && !!navigator.credentials?.create
    && window.isSecureContext;
}

export function biolockEnabled(): boolean {
  try { return !!localStorage.getItem(CRED_KEY); } catch { return false; }
}

export async function enableBiolock(): Promise<boolean> {
  if (!biolockSupported()) return false;
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'kremote' },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'kremote-user',
          displayName: 'kremote user',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60_000,
      },
    }) as PublicKeyCredential | null;
    if (!cred) return false;
    const id = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
    try { localStorage.setItem(CRED_KEY, id); } catch { /* private mode */ }
    return true;
  } catch {
    return false;
  }
}

export function disableBiolock(): void {
  try { localStorage.removeItem(CRED_KEY); } catch { /* private mode */ }
}

/**
 * If biolock is enabled, require a platform-authenticator gesture before the
 * caller may use the stored session token. Resolves true when unlocked (or
 * when biolock is off/unsupported — fail open is intentional: the lock is a
 * convenience gate, and locking the user out entirely on a browser quirk
 * would be worse).
 */
export async function unlockSession(): Promise<boolean> {
  if (!biolockEnabled() || !biolockSupported()) return true;
  try {
    const id = localStorage.getItem(CRED_KEY)!;
    const rawId = Uint8Array.from(atob(id), c => c.charCodeAt(0));
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: rawId }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return true;
  } catch {
    return false; // user cancelled / verification failed
  }
}
