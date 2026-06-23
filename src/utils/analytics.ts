/**
 * GA4 Measurement Protocol shim — fire-and-forget HTTP.
 *
 * Firebase Analytics has no Node.js SDK, so we ship lightweight events to
 * GA4 directly via the Measurement Protocol. Two env vars opt in:
 *
 *   ANVILWING_GA_MEASUREMENT_ID   e.g. G-6G9HQ9E20S
 *   ANVILWING_GA_API_SECRET        the API secret from the GA4 Data Stream
 *
 * If either is missing, every call is a no-op. We never block the CLI on
 * the network round-trip.
 */
import os from 'node:os';
import crypto from 'node:crypto';

const MEASUREMENT_ID = process.env.ANVILWING_GA_MEASUREMENT_ID || '';
const API_SECRET = process.env.ANVILWING_GA_API_SECRET || '';
const DISABLED = process.env.ANVILWING_DISABLE_ANALYTICS === '1';

let cachedClientId: string | null = null;
function clientId(): string {
  if (cachedClientId) return cachedClientId;
  // Stable per-machine, non-PII: hash of hostname + platform + arch.
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`;
  cachedClientId = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return cachedClientId;
}

export function track(eventName: string, params: Record<string, unknown> = {}): void {
  if (DISABLED || !MEASUREMENT_ID || !API_SECRET) return;
  const payload = {
    client_id: clientId(),
    events: [{
      name: eventName,
      params: {
        cli_version: params.cli_version ?? process.env.npm_package_version ?? 'unknown',
        node_version: process.versions.node,
        platform: os.platform(),
        arch: os.arch(),
        ...params,
      },
    }],
  };
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;
  // Fire and forget — no await, no error surface.
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
