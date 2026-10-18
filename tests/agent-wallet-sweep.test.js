// The owner's wallet sweep before deleting an agent (salt-api POST /api/v1/agents/:id/wallet_sweep).
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

test("sweepAgentWallet POSTs to the agent's wallet_sweep with the owner's key", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts?.method, key: opts?.headers?.["api-key"] });
    const body = { requested: [{ wallet_id: "w1", chain: "ethereum", testnet: false, balance: "1.0", to: "0xabc", to_wallet_id: "w2" }], next: "delete again" };
    return { ok: true, status: 202, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const out = await client.sweepAgentWallet("owner-key", "a1");
  assert.deepStrictEqual(calls, [{ url: "https://salt.test/api/v1/agents/a1/wallet_sweep", method: "POST", key: "owner-key" }]);
  assert.strictEqual(out.requested[0].to, "0xabc");
});
