/**
 * WebRTC signalling hub — how the host's screen reaches everyone else.
 *
 * The video itself NEVER touches this server: WebRTC sends it peer-to-peer. All
 * this does is pass the introduction notes (SDP offers/answers and ICE
 * candidates) between the host and each viewer until they can talk directly.
 *
 * Transport is SSE down + POST up, deliberately. Signalling is a handful of small
 * messages per peer, so a WebSocket library would be a dependency bought for
 * nothing — and SSE reconnects on its own, which a hand-rolled socket would not.
 *
 * Topology is one host to N viewers (a star, not a mesh). The host encodes and
 * uploads a separate stream per viewer, so their UPLOAD is the ceiling: ~6 friends
 * is realistic on home broadband, 20 is not.
 */

/**
 * @typedef {Object} Peer
 * @property {string} id
 * @property {'host'|'viewer'} role
 * @property {import('express').Response} res  the open SSE response
 * @property {number} joinedAt
 */

/** @type {Map<string, Map<string, Peer>>} room -> peerId -> Peer */
const rooms = new Map();

const room = (name) => {
  if (!rooms.has(name)) rooms.set(name, new Map());
  return rooms.get(name);
};

/** Push one SSE frame. Returns false if the socket is already gone. */
function send(peer, type, payload) {
  try {
    peer.res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach a peer's SSE stream. Called from GET /api/signal/:room/:id.
 */
export function join(req, res, roomName, peerId, role) {
  const r = room(roomName);

  // A reconnecting peer (same id) replaces its old stream rather than
  // duplicating — EventSource retries on its own after any blip.
  const existing = r.get(peerId);
  if (existing) {
    try { existing.res.end(); } catch { /* already dead */ }
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx/Cloudflare will otherwise buffer SSE into uselessness.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const peer = { id: peerId, role, res, joinedAt: Date.now() };
  r.set(peerId, peer);

  send(peer, 'joined', { peerId, role });

  // Tell the newcomer whether anyone is broadcasting, and tell the host to start
  // offering to this viewer. Both directions matter: a viewer can arrive before
  // OR after the host starts sharing.
  const host = [...r.values()].find((p) => p.role === 'host');
  if (role === 'viewer') {
    send(peer, host ? 'host-present' : 'no-host', {});
    if (host) send(host, 'viewer-joined', { peerId });
  } else {
    // A host arriving/re-arriving: every existing viewer needs an offer.
    for (const p of r.values()) {
      if (p.role === 'viewer') {
        send(peer, 'viewer-joined', { peerId: p.id });
        send(p, 'host-present', {});
      }
    }
  }

  // Comment frames keep proxies from closing an idle stream.
  const ka = setInterval(() => {
    try { res.write(': ka\n\n'); } catch { /* cleaned up below */ }
  }, 20_000);
  ka.unref?.();

  req.on('close', () => {
    clearInterval(ka);
    if (r.get(peerId) === peer) r.delete(peerId);
    // If the host leaves, viewers must be told — otherwise they sit on a frozen
    // last frame forever, which looks exactly like a working stream.
    if (role === 'host') {
      for (const p of r.values()) if (p.role === 'viewer') send(p, 'host-gone', {});
    } else if (host) {
      send(host, 'viewer-left', { peerId });
    }
    if (!r.size) rooms.delete(roomName);
  });
}

/**
 * Relay one message to a specific peer (or to the host if `to` is omitted).
 * @returns {boolean} whether it was delivered
 */
export function relay(roomName, fromId, to, type, payload) {
  const r = rooms.get(roomName);
  if (!r) return false;
  const target = to ? r.get(to) : [...r.values()].find((p) => p.role === 'host');
  if (!target) return false;
  // Keep `payload` NESTED. Spreading it here flattens {sdp} to the message root,
  // where every client reading msg.payload.sdp gets undefined and the handshake
  // silently never completes — and an SDP key could collide with `type`/`from`.
  return send(target, type, { payload, from: fromId });
}

/** Room status for the UI: is anyone sharing, and how many are watching. */
export function status(roomName) {
  const r = rooms.get(roomName);
  if (!r) return { sharing: false, viewers: 0 };
  const peers = [...r.values()];
  return {
    sharing: peers.some((p) => p.role === 'host'),
    viewers: peers.filter((p) => p.role === 'viewer').length,
  };
}
