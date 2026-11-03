// Imported first by jsdom component tests that build signed fixtures. jsdom installs its own
// Uint8Array and TextEncoder, whose instances come from a different realm than the Node-loaded
// tweetnacl, which then refuses them. Pointing these globals at Node's own classes before any
// crypto module is imported keeps every byte array in one realm. Real browsers have a single
// realm, so this is a test-only concern (see apps/web/vite.config.ts).
import { TextEncoder as NodeTextEncoder } from 'node:util';

// A TextEncoder from node:util produces a genuine Node Uint8Array; its constructor is the class
// tweetnacl captured at import time.
const NodeUint8Array = new NodeTextEncoder().encode('').constructor as Uint8ArrayConstructor;

globalThis.Uint8Array = NodeUint8Array;
globalThis.TextEncoder = NodeTextEncoder as typeof globalThis.TextEncoder;
