// Resolve a reachable Plex address: PLEX_URL if it answers, otherwise
// whichever of the server's direct addresses answers first, and Plex Relay
// only when no direct address answers.

const PLEX_TV = 'https://plex.tv';

async function respondsAsPlex(uri, token, expectedMachineIdentifier, timeoutMs, signal) {
  try {
    const res = await fetch(`${uri}/identity`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    if (!expectedMachineIdentifier) return true;
    const data = await res.json().catch(() => null);
    return data?.MediaContainer?.machineIdentifier === expectedMachineIdentifier;
  } catch {
    return false;
  }
}

// Probe every candidate at once; within a tier the first to answer wins, so a
// dead or slow address never delays a working one. A later tier is used only
// when every address in the tiers before it failed.
export async function firstReachable(tiers, probe) {
  const controller = new AbortController();
  const started = tiers.map(tier => tier.map((candidate) => {
    const attempt = probe(candidate, controller.signal).then((ok) => {
      if (!ok) throw new Error('unreachable');
      return candidate;
    });
    attempt.catch(() => {}); // later tiers may never be awaited
    return attempt;
  }));
  try {
    for (const attempts of started) {
      if (!attempts.length) continue;
      try { return await Promise.any(attempts); } catch { /* none in this tier answered */ }
    }
    return null;
  } finally { controller.abort(); }
}

// Try the configured URL first, then discover and probe Plex connections.
export function plexDeviceHeaders(productName) {
  return {
    'X-Plex-Product': productName,
    'X-Plex-Device': productName,
    'X-Plex-Device-Name': productName,
  };
}

export async function resolvePlexUrl({ token, clientId, productName, preferredUrl, timeoutMs = 4000 }) {
  if (preferredUrl && (await respondsAsPlex(preferredUrl, token, null, timeoutMs))) {
    return preferredUrl;
  }
  if (preferredUrl) {
    console.warn('PLEX_URL did not answer as a Plex server, so the server is being looked up through plex.tv instead. If you own more than one Plex server, that may not be the one you want: fix PLEX_URL or the server it points to.');
  }

  const res = await fetch(`${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1`, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': clientId,
      ...plexDeviceHeaders(productName),
    },
    redirect: 'error',
      signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    if (preferredUrl) {
      console.warn(`Plex resources lookup failed (${res.status}); falling back to configured PLEX_URL unverified`);
      return preferredUrl;
    }
    throw new Error(`Plex resources lookup failed: ${res.status}`);
  }
  const resources = await res.json();
  const owned = resources.filter((r) => r.owned && (r.provides || '').includes('server') && (!process.env.PLEX_SERVER_ID || r.clientIdentifier === process.env.PLEX_SERVER_ID));
  const server = owned[0];
  if (owned.length > 1) {
    console.warn(`This account owns ${owned.length} Plex servers. Using "${server.name || 'the first one'}", the first plex.tv lists. To use a different one, set PLEX_URL to its address.`);
  }
  if (!server) {
    if (preferredUrl) return preferredUrl;
    throw new Error('No owned Plex server found on this account');
  }

  // Direct addresses (local or remote) race together; Plex Relay, which caps
  // bandwidth at 1-2 Mbps, is used only when none of them answers.
  const connections = server.connections || [];
  const tiers = [connections.filter(c => !c.relay), connections.filter(c => c.relay)];
  const conn = await firstReachable(tiers, (candidate, signal) =>
    respondsAsPlex(candidate.uri, token, server.clientIdentifier, timeoutMs, signal));
  if (conn) {
    if (conn.relay) {
      console.warn('Plex server is only reachable via Relay -- Plex caps Relay bandwidth at 1-2 Mbps, so video quality will suffer until a direct connection is available again.');
    }
    return conn.uri;
  }

  if (preferredUrl) {
    console.warn('No reachable connection found for this Plex server via plex.tv; falling back to configured PLEX_URL unverified');
    return preferredUrl;
  }
  throw new Error('No reachable connection found for this Plex server');
}
