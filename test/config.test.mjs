import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.mjs";

const HOME = "/home/someone";
const files = { "/keys/board": "  secret-token\n", "/home/someone/.paperclip/key": "home-token\n" };
const readFile = (path) => {
  if (path in files) return files[path];
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
};
const load = (env) => loadConfig(env, { readFile, homedir: HOME });

const complete = {
  PAPERCLIP_BOARD_TOKEN_FILE: "/keys/board",
  PAPERCLIP_COMPANY: "REP",
  PAPERCLIP_CHAT_AGENT: "chief-of-staff",
};

test("reads a complete configuration with defaults for the optional settings", () => {
  const config = load(complete);
  assert.deepEqual(config.problems, []);
  assert.equal(config.apiBase, "http://127.0.0.1:3100/api");
  assert.equal(config.token, "secret-token");
  assert.equal(config.companyRef, "REP");
  assert.equal(config.agentRef, "chief-of-staff");
  assert.equal(config.pollMs, 2000);
  assert.equal(config.turnTimeoutMs, 20 * 60 * 1000);
});

test("lists every missing required setting", () => {
  const { problems } = load({});
  assert.equal(problems.length, 3);
  assert.match(problems.join("\n"), /PAPERCLIP_BOARD_TOKEN_FILE/);
  assert.match(problems.join("\n"), /PAPERCLIP_COMPANY/);
  assert.match(problems.join("\n"), /PAPERCLIP_CHAT_AGENT/);
});

test("names the token file when it cannot be read or is empty", () => {
  assert.match(load({ ...complete, PAPERCLIP_BOARD_TOKEN_FILE: "/keys/missing" }).problems.join(), /\/keys\/missing/);
  files["/keys/empty"] = "\n";
  assert.match(load({ ...complete, PAPERCLIP_BOARD_TOKEN_FILE: "/keys/empty" }).problems.join(), /\/keys\/empty.*empty/);
});

test("expands a leading ~ in the token file path", () => {
  const config = load({ ...complete, PAPERCLIP_BOARD_TOKEN_FILE: "~/.paperclip/key" });
  assert.deepEqual(config.problems, []);
  assert.equal(config.token, "home-token");
});

test("accepts a custom API base and drops a trailing slash", () => {
  assert.equal(load({ ...complete, PAPERCLIP_API_BASE: "http://127.0.0.1:40130/api/" }).apiBase, "http://127.0.0.1:40130/api");
});

test("rejects poll and timeout values that are not positive numbers", () => {
  const { problems } = load({ ...complete, BRIDGE_POLL_MS: "fast", BRIDGE_TURN_TIMEOUT_MS: "0" });
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /BRIDGE_POLL_MS/);
  assert.match(problems.join("\n"), /BRIDGE_TURN_TIMEOUT_MS/);
});

test("rejects a token file that is not a single printable line, without echoing it", () => {
  files["/keys/pasted"] = "export PAPERCLIP_API_KEY=abc\nsecret-value\n";
  const { problems, token } = load({ ...complete, PAPERCLIP_BOARD_TOKEN_FILE: "/keys/pasted" });
  assert.equal(token, "");
  assert.match(problems.join(), /\/keys\/pasted.*single line/);
  assert.doesNotMatch(problems.join(), /secret-value/);
});
