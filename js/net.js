// Thin wrapper around PeerJS so main.js doesn't deal with Peer/DataConnection
// plumbing directly. Uses the free public PeerJS cloud broker for signaling —
// no server of our own needed.

export function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export class Net {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.isHost = false;

    // Assign these from outside to react to events.
    this.onData = null;             // (data) => void
    this.onPeerConnected = null;    // () => void
    this.onPeerDisconnected = null; // () => void
  }

  /**
   * Host a match. Tries `code`; if that ID is taken on the PeerJS broker,
   * retries with a fresh random code up to `attempts` times.
   * Resolves with the code that actually got registered.
   */
  host(code, attempts = 5) {
    return new Promise((resolve, reject) => {
      const tryCode = (c, left) => {
        const peer = new Peer(c, { debug: 1 });
        this.isHost = true;

        peer.on("open", (id) => {
          this.peer = peer;
          peer.on("connection", (conn) => {
            this.conn = conn;
            this._wire(conn);
          });
          resolve(id);
        });

        peer.on("error", (err) => {
          if (err.type === "unavailable-id" && left > 0) {
            peer.destroy();
            tryCode(randomCode(), left - 1);
          } else {
            reject(err);
          }
        });
      };
      tryCode(code, attempts);
    });
  }

  /** Join a hosted match by its 6-digit code. */
  join(code) {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      const peer = new Peer({ debug: 1 });

      peer.on("open", () => {
        this.peer = peer;
        const conn = peer.connect(code, { reliable: true });
        this.conn = conn;

        conn.on("open", () => {
          this._wire(conn);
          resolve();
        });
        conn.on("error", (err) => reject(err));
      });

      peer.on("error", (err) => reject(err));
    });
  }

  _wire(conn) {
    conn.on("data", (data) => {
      if (this.onData) this.onData(data);
    });
    conn.on("close", () => {
      if (this.onPeerDisconnected) this.onPeerDisconnected();
    });
    if (this.onPeerConnected) this.onPeerConnected();
  }

  send(data) {
    if (this.conn && this.conn.open) this.conn.send(data);
  }

  destroy() {
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.conn = null;
  }
}
