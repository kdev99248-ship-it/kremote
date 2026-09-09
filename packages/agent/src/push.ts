// Web Push sender (agent-side). The agent — not the relay — owns push:
//  - it generates and persists a VAPID keypair in its config (once),
//  - stores the browser push subscriptions handed to it over the protocol,
//  - posts notifications straight to the push service (FCM/Mozilla/Apple) using
//    its own outbound internet connection.
// The relay never sees the keys; it only forwards the push.* frames.

import webpush from 'web-push';
import type { PushSub } from '@kremote/shared';
import type { AgentConfig } from './config.ts';
import { saveConfig } from './config.ts';

// A `mailto:`/`https:` subject is required by the VAPID spec (push services use
// it to contact the sender about problems). A placeholder is fine for a
// personal tool; nothing is actually emailed.
const VAPID_SUBJECT = 'mailto:agent@kremote.local';

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
}

export class PushSender {
  private readonly cfg: AgentConfig;
  private readonly save: () => Promise<void>;

  constructor(cfg: AgentConfig, save: () => Promise<void> = () => saveConfig(cfg)) {
    this.cfg = cfg;
    this.save = save;
  }

  /** Ensure a VAPID keypair exists (generate + persist on first use) and return
   *  the public key the browser needs to subscribe. */
  async ensureVapid(): Promise<string> {
    if (!this.cfg.vapid) {
      this.cfg.vapid = webpush.generateVAPIDKeys();
      await this.save();
    }
    webpush.setVapidDetails(VAPID_SUBJECT, this.cfg.vapid.publicKey, this.cfg.vapid.privateKey);
    return this.cfg.vapid.publicKey;
  }

  /** Register a browser subscription (deduped by endpoint). */
  async add(sub: PushSub): Promise<void> {
    const subs = (this.cfg.pushSubs ??= []);
    if (subs.some((s) => s.endpoint === sub.endpoint)) return;
    subs.push(sub);
    await this.save();
  }

  /** Drop a subscription by endpoint. */
  async remove(endpoint: string): Promise<void> {
    const subs = this.cfg.pushSubs;
    if (!subs?.length) return;
    const next = subs.filter((s) => s.endpoint !== endpoint);
    if (next.length !== subs.length) {
      this.cfg.pushSubs = next;
      await this.save();
    }
  }

  /** Send a notification to every registered subscription. Subscriptions the
   *  push service reports as gone (404/410) are pruned. No-op with no VAPID or
   *  no subscriptions. */
  async send(payload: PushPayload): Promise<void> {
    const subs = this.cfg.pushSubs;
    if (!this.cfg.vapid || !subs?.length) return;
    webpush.setVapidDetails(VAPID_SUBJECT, this.cfg.vapid.publicKey, this.cfg.vapid.privateKey);
    const data = JSON.stringify(payload);
    const gone: string[] = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(s as any, data);
      } catch (err: any) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) gone.push(s.endpoint);
        // Other errors (network, 5xx) are transient — keep the subscription.
      }
    }));
    if (gone.length) {
      this.cfg.pushSubs = subs.filter((s) => !gone.includes(s.endpoint));
      await this.save();
    }
  }
}
