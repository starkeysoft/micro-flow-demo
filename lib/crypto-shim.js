// Browser stand-in for Node's `crypto` module. micro-flow only calls
// crypto.randomUUID(), which browsers expose only in secure contexts (HTTPS or
// localhost). Fall back to getRandomValues so pages also work over plain HTTP
// on a LAN address.
const web_crypto = globalThis.crypto;

function randomUUID() {
  if (typeof web_crypto.randomUUID === 'function') {
    return web_crypto.randomUUID();
  }

  const bytes = web_crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default { randomUUID };
