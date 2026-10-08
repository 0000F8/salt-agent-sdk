// Device control (remote control of the owner's own machines). Behind
// salt-api's `Feature :remote_control`; every route 404s while the flag is off.
//
// The protocol grammar lives in salt-api/docs/DEVICE_PROTOCOL.md and is
// mirrored in protocol.ts. This module ships the agent client, the device host
// (minus its two injected capture/input seams) and real HTTP transports.
export * from "./protocol.js";
export * from "./client.js";
export * from "./host.js";
export * from "./http.js";
