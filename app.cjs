/* eslint-disable */
/**
 * CommonJS entry point for Phusion Passenger — cPanel's Node.js hosting.
 *
 * package.json declares "type": "module", so src/server.js is ESM. Passenger
 * loads the configured startup file with require(), and require() of an ESM
 * file throws ERR_REQUIRE_ESM. The process never starts, and Passenger serves
 * "Web application could not be started" with the real cause in a log only
 * root can read.
 *
 * The .cjs extension keeps this file CommonJS despite "type": "module", and
 * dynamic import() is the one way CommonJS may load ESM. Passenger patches
 * http.Server.listen globally before the startup file runs, so by the time
 * server.js calls listen() the patch is already in place and the server binds
 * the socket Passenger assigned rather than a port of its own — which is also
 * why PORT must not be pinned in the environment.
 *
 * Point cPanel's "Application startup file" at this file.
 */
import('./src/server.js').catch((err) => {
  // Passenger shows none of this, but it lands in the app's stderr log and is
  // what you see if you run `node app.cjs` by hand.
  console.error('carisca-api failed to start:', err);
  process.exit(1);
});
