// Reads the bridge's settings from the environment. Problems are collected
// rather than thrown so the bridge still starts and Paseo can show them.
import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

const DEFAULT_API_BASE = "http://127.0.0.1:3100/api";

export function loadConfig(env = process.env, { readFile = (path) => readFileSync(path, "utf8"), homedir = osHomedir() } = {}) {
  const problems = [];

  const required = (name, meaning) => {
    const value = env[name]?.trim();
    if (!value) problems.push(`Set ${name} to ${meaning}.`);
    return value ?? "";
  };

  const positiveNumber = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!(value > 0)) problems.push(`${name} must be a positive number of milliseconds (got "${env[name]}").`);
    return value;
  };

  let token = "";
  const tokenFile = required("PAPERCLIP_BOARD_TOKEN_FILE", "the path of a file holding a Paperclip board API key");
  if (tokenFile) {
    const path = tokenFile.startsWith("~/") ? join(homedir, tokenFile.slice(2)) : tokenFile;
    try {
      const contents = readFile(path).trim();
      if (!contents) problems.push(`The board token file ${path} is empty.`);
      // Never echo the contents: a pasted block may hold the key next to other text.
      else if (!/^[\x21-\x7e]+$/.test(contents)) problems.push(`The board token file ${path} must hold only the key, on a single line.`);
      else token = contents;
    } catch (error) {
      problems.push(`Could not read the board token file ${path} (${error.code ?? error.message}).`);
    }
  }

  return {
    apiBase: (env.PAPERCLIP_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, ""),
    token,
    companyRef: required("PAPERCLIP_COMPANY", "the company's id or issue prefix (for example ACME)"),
    agentRef: required("PAPERCLIP_CHAT_AGENT", "the agent's URL key or id (for example chief-of-staff)"),
    pollMs: positiveNumber("BRIDGE_POLL_MS", 2000),
    turnTimeoutMs: positiveNumber("BRIDGE_TURN_TIMEOUT_MS", 20 * 60 * 1000),
    problems,
  };
}
