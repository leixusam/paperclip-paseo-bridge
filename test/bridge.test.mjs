import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as acp from "@agentclientprotocol/sdk";
import { createBridgeAgent } from "../bridge.mjs";

const COMPANY = "company-1";
const AGENT_ID = "agent-cos";
const TOKEN = "board-test-token";
const COMPANIES = [
  { id: "company-0", name: "Other", issuePrefix: "OTH" },
  { id: COMPANY, name: "Example Studio", issuePrefix: "REP" },
];

// Fake Paperclip API. `script(tick)` runs on every comments poll and may add
// agent comments or change run status, so tests advance deterministically.
async function startFakePaperclip(script, { onRunStatus = () => {}, failCommentPolls = [] } = {}) {
  const state = { chat: null, comments: [], runs: new Map(), polls: 0, requests: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const chunk of req) body += chunk;
    state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
    if (url.pathname === "/api/companies" && req.method === "GET") return send(200, COMPANIES);
    const chatPath = `/api/companies/${COMPANY}/chats/chief-of-staff`;
    if (url.pathname === chatPath && req.method === "GET") return send(200, state.chat);
    if (url.pathname === chatPath && req.method === "POST") {
      state.chat ??= { id: "issue-1", identifier: "REP-3", conversationAgentId: AGENT_ID };
      return send(201, state.chat);
    }
    if (url.pathname === "/api/issues/issue-1/comments" && req.method === "POST") {
      const parsed = JSON.parse(body);
      const comment = { id: `c${state.comments.length + 1}`, authorType: "user", body: parsed.body, clientRequestId: parsed.clientRequestId };
      state.comments.push(comment);
      return send(201, comment);
    }
    if (url.pathname === "/api/issues/issue-1/comments" && req.method === "GET") {
      state.polls += 1;
      if (failCommentPolls.includes(state.polls)) return send(500, { error: "restarting" });
      script(state.polls, state);
      const after = url.searchParams.get("afterCommentId");
      // Like the real Paperclip API, "after" is inclusive: it returns that comment too.
      const index = after ? state.comments.findIndex((c) => c.id === after) : 0;
      return send(200, state.comments.slice(Math.max(index, 0)));
    }
    const runMatch = url.pathname.match(/^\/api\/heartbeat-runs\/(.+)$/);
    if (runMatch) onRunStatus(runMatch[1], state);
    if (runMatch) return send(200, { id: runMatch[1], status: state.runs.get(runMatch[1]) ?? "running" });
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref(); // a failed assertion must not keep the test process alive
  return { state, apiBase: `http://127.0.0.1:${server.address().port}/api`, close: () => { server.closeAllConnections(); server.close(); } };
}

function agentReply(state, body, runId) {
  state.comments.push({ id: `c${state.comments.length + 1}`, authorType: "agent", authorAgentId: AGENT_ID, createdByRunId: runId, body });
}

// Wires an in-process ACP client to the bridge agent and records updates.
async function connect(options) {
  const toAgent = new TransformStream();
  const toClient = new TransformStream();
  const updates = [];
  new acp.AgentSideConnection((conn) => createBridgeAgent(conn, options), acp.ndJsonStream(toClient.writable, toAgent.readable));
  const client = new acp.ClientSideConnection(
    () => ({
      sessionUpdate: async (n) => { updates.push(n.update); },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
    acp.ndJsonStream(toAgent.writable, toClient.readable),
  );
  await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] });
  return { client, sessionId, updates };
}

const text = (updates) => updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text);
const noSleep = async () => {};

test("posts the prompt as a chat comment and streams the agent reply after its run finishes", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 2) { agentReply(state, "Hi.", "run-1"); state.runs.set("run-1", "running"); }
    if (tick === 4) state.runs.set("run-1", "succeeded");
  });
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
  api.close();
  assert.equal(result.stopReason, "end_turn");
  const posted = api.state.requests.find((r) => r.method === "POST" && r.path.endsWith("/comments"));
  const body = JSON.parse(posted.body);
  assert.equal(body.body, "hello");
  assert.match(body.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(text(updates), ["Hi."]);
  assert.ok(api.state.polls >= 4, "turn must not end before the run is terminal");
});

test("emits each reply once even though the API repeats the anchor comment", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 1) { agentReply(state, "Only once.", "run-9"); state.runs.set("run-9", "running"); }
    if (tick === 5) state.runs.set("run-9", "succeeded");
  });
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
  api.close();
  assert.deepEqual(text(updates), ["Only once."]);
});

test("streams several replies from one run in order", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 1) agentReply(state, "First.", "run-2");
    if (tick === 2) { agentReply(state, "Second.", "run-2"); state.runs.set("run-2", "succeeded"); }
  });
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "two things" }] });
  api.close();
  assert.deepEqual(text(updates), ["First.", "\n\nSecond."]);
});

test("streams a last reply that lands just as the run finishes", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 1) agentReply(state, "Working on it.", "run-5");
  }, {
    // The final comment and the terminal status both appear between a comments poll and the run check.
    onRunStatus: (id, state) => {
      if (state.runs.get(id) === undefined && state.polls >= 2) { agentReply(state, "Done.", id); state.runs.set(id, "succeeded"); }
    },
  });
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
  api.close();
  assert.deepEqual(text(updates), ["Working on it.", "\n\nDone."]);
});

test("keeps waiting through a brief Paperclip outage while polling", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 4) { agentReply(state, "Back.", "run-6"); state.runs.set("run-6", "succeeded"); }
  }, { failCommentPolls: [2, 3] });
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
  api.close();
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(text(updates), ["Back."]);
});

test("a lasting outage while polling fails the turn with Paperclip's error", async () => {
  const api = await startFakePaperclip(() => {}, { failCommentPolls: [1, 2, 3, 4, 5, 6] });
  const { client, sessionId } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  try {
    await assert.rejects(client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }), (error) => /500/.test(error.message) && /restarting/.test(error.message));
  } finally {
    api.close();
  }
});

test("network errors name the request but never the token", async () => {
  const fetchImpl = async () => { throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value`); };
  const { client, sessionId } = await connect({ apiBase: "http://127.0.0.1:9/api", token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000, fetchImpl });
  await assert.rejects(client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }), (error) => /GET \/companies/.test(error.message) && !error.message.includes(TOKEN));
});

test("says the run is still going when a reply arrived but the run outlasts the timeout", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 1) { agentReply(state, "Started.", "run-7"); state.runs.set("run-7", "running"); }
  });
  let now = 0;
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: async () => { now += 1000; }, now: () => now, turnTimeoutMs: 5000 });
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "long job" }] });
  api.close();
  const all = text(updates).join("");
  assert.match(all, /still running after/i);
  assert.doesNotMatch(all, /no reply yet/i);
});

test("reports a failed run instead of waiting forever", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 1) { agentReply(state, "Starting.", "run-3"); state.runs.set("run-3", "failed"); }
  });
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
  api.close();
  assert.equal(result.stopReason, "end_turn");
  assert.match(text(updates).join(""), /run failed/i);
});

test("ends the turn with a notice when no reply arrives in time", async () => {
  const api = await startFakePaperclip(() => {});
  let now = 0;
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: async () => { now += 1000; }, now: () => now, turnTimeoutMs: 5000 });
  const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: "anyone?" }] });
  api.close();
  assert.equal(result.stopReason, "end_turn");
  assert.match(text(updates).join(""), /no reply yet/i);
});

test("cancel stops waiting and reports cancelled", async () => {
  const api = await startFakePaperclip(() => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { client, sessionId } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: COMPANY, agentRef: "chief-of-staff", sleep: () => gate, turnTimeoutMs: 60_000 });
  const pending = client.prompt({ sessionId, prompt: [{ type: "text", text: "long task" }] });
  await new Promise((resolve) => setImmediate(resolve));
  await client.cancel({ sessionId });
  release();
  const result = await pending;
  api.close();
  assert.equal(result.stopReason, "cancelled");
});

test("finds the company by its issue prefix, ignoring case", async () => {
  const api = await startFakePaperclip((tick, state) => {
    if (tick === 1) { agentReply(state, "Found you.", "run-4"); state.runs.set("run-4", "succeeded"); }
  });
  const { client, sessionId, updates } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: "rep", agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
  api.close();
  assert.deepEqual(text(updates), ["Found you."]);
  assert.ok(api.state.requests.some((r) => r.path === `/api/companies/${COMPANY}/chats/chief-of-staff`));
});

test("an unknown company fails the prompt and lists the companies the key can see", async () => {
  const api = await startFakePaperclip(() => {});
  const { client, sessionId } = await connect({ apiBase: api.apiBase, token: TOKEN, companyRef: "NOPE", agentRef: "chief-of-staff", sleep: noSleep, turnTimeoutMs: 60_000 });
  try {
    await assert.rejects(client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }), (error) => /NOPE/.test(error.message) && /OTH/.test(error.message) && /REP/.test(error.message));
    assert.ok(!api.state.requests.some((r) => r.method === "POST"), "nothing may be posted");
  } finally {
    api.close();
  }
});

test("configuration problems fail the prompt with every problem listed and nothing posted", async () => {
  const api = await startFakePaperclip(() => {});
  const problems = ["Set PAPERCLIP_COMPANY", "Could not read the board token file /nowhere/board-token"];
  const { client, sessionId } = await connect({ apiBase: api.apiBase, problems, sleep: noSleep, turnTimeoutMs: 60_000 });
  try {
    await assert.rejects(client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }), (error) => /PAPERCLIP_COMPANY/.test(error.message) && /\/nowhere\/board-token/.test(error.message));
    assert.equal(api.state.requests.length, 0);
  } finally {
    api.close();
  }
});
