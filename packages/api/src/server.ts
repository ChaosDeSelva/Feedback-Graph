import type { Server } from 'node:http';

/**
 * How long an idle keep-alive connection stays open: longer than the 60 s idle timeout of common reverse proxies and
 * load balancers, so they close first and never send a request down a socket Node is closing (Node's default is 5 s).
 */
export const KEEP_ALIVE_MS = 65_000;

export function tuneServer(server: Server): void {
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  // Above keepAliveTimeout, or Node may drop a reused connection while its next request's headers arrive.
  server.headersTimeout = KEEP_ALIVE_MS + 1000;
}

/**
 * Stop taking requests and end the long-lived ones now: `closing` ends every event stream (createApp's opts.closing),
 * idle keep-alive sockets are closed, and whatever is still open after graceMs is cut. Resolves once the server closed.
 */
export function stopServer(server: Server, closing: AbortController, o: { graceMs: number }): Promise<void> {
  return new Promise((resolve) => {
    closing.abort();
    server.close(() => resolve());
    // A connection turns idle when its last response ends (an event stream just ended): close those as they do.
    server.closeIdleConnections();
    const idle = setInterval(() => server.closeIdleConnections(), 50);
    const cut = setTimeout(() => server.closeAllConnections(), o.graceMs);
    idle.unref();
    cut.unref();
    server.once('close', () => {
      clearInterval(idle);
      clearTimeout(cut);
    });
  });
}
