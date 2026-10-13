#!/usr/bin/env node
// ACP agent that lets Paseo chat with a Paperclip agent through Paperclip's
// Agent Chat. Each prompt becomes a chat comment; the agent's reply comments
// stream back once they appear, and the turn ends when their run finishes.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { loadConfig } from "./config.mjs";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

// Consecutive failed polls tolerated before the turn fails (covers a Paperclip restart).
const MAX_POLL_FAILURES = 3;
const REQUEST_TIMEOUT_MS = 30_000;

// Carries its message to Paseo, which shows plain errors only as "Internal error".
class PaperclipRequestError extends acp.RequestError {
  constructor(message) {
    super(-32603, message);
  }
}

const abortableDelay = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

export function createBridgeAgent(connection, options) {
  const {
    apiBase,
    token,
    companyRef,
    agentRef,
    problems = [],
    pollMs = 2000,
    turnTimeoutMs = 20 * 60 * 1000,
    sleep = abortableDelay,
    now = Date.now,
    fetchImpl = fetch,
  } = options;
  const sessions = new Map();
  let companyId;

  async function api(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // The error's own message may quote request headers, so only its kind is reported.
      throw new PaperclipRequestError(`Paperclip ${method} ${path} failed: could not reach ${apiBase} (${error.cause?.code ?? error.name})`);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new PaperclipRequestError(`Paperclip ${method} ${path} failed (${response.status}): ${data?.error ?? response.statusText}`);
    }
    return data;
  }

  // Accepts a company id or issue prefix; remembers the id once found.
  async function resolveCompany() {
    if (companyId) return companyId;
    const companies = await api("GET", "/companies");
    const list = Array.isArray(companies) ? companies : companies?.items ?? [];
    const match =
      list.find((company) => company.id === companyRef) ??
      list.find((company) => company.issuePrefix?.toLowerCase() === companyRef.toLowerCase());
    if (!match) {
      const known = list.map((company) => `${company.issuePrefix} (${company.name})`).join(", ") || "none";
      throw new acp.RequestError(-32603, `No Paperclip company matches PAPERCLIP_COMPANY="${companyRef}". Companies this key can see: ${known}.`);
    }
    companyId = match.id;
    return companyId;
  }

  async function openChat() {
    const companyId = await resolveCompany();
    const path = `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`;
    return (await api("GET", path)) ?? (await api("POST", path, {}));
  }

  const say = (sessionId, text) =>
    connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

  return {
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
    },

    async newSession() {
      const sessionId = randomUUID();
      sessions.set(sessionId, { abort: null });
      return { sessionId };
    },

    async authenticate() {
      return {};
    },

    async prompt({ sessionId, prompt }) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}`);
      if (problems.length > 0) {
        throw new acp.RequestError(-32603, `The Paperclip bridge is not configured:\n- ${problems.join("\n- ")}`);
      }

      const body = prompt
        .map((block) => (block.type === "text" ? block.text : block.type === "resource_link" ? block.uri : block.resource?.text ?? ""))
        .filter(Boolean)
        .join("\n\n");
      session.abort?.abort();
      const abort = new AbortController();
      session.abort = abort;

      const chat = await openChat();
      const posted = await api("POST", `/issues/${chat.id}/comments`, { body, clientRequestId: randomUUID() });

      // Paperclip's afterCommentId is inclusive, so remember what was already handled.
      let lastSeen = posted.id;
      const seen = new Set([posted.id]);
      let replies = 0;
      const runIds = new Set();
      const started = now();
      let failures = 0;
      let wrote = false;
      let noticeToCheck = false;
      const write = async (text) => {
        await say(sessionId, (wrote ? "\n\n" : "") + text);
        wrote = true;
      };

      async function streamNewReplies() {
        const comments = await api("GET", `/issues/${chat.id}/comments?afterCommentId=${lastSeen}&order=asc`);
        for (const comment of comments) {
          if (seen.has(comment.id)) continue;
          seen.add(comment.id);
          lastSeen = comment.id;
          if (comment.authorType === "system") {
            await write(`_(Paperclip: ${comment.body})_`);
            noticeToCheck = true;
            continue;
          }
          if (comment.authorType !== "agent") continue;
          await write(comment.body);
          replies += 1;
          if (comment.createdByRunId) runIds.add(comment.createdByRunId);
        }
      }

      while (true) {
        if (abort.signal.aborted) return { stopReason: "cancelled" };
        try {
          await streamNewReplies();
          // Paperclip can block the chat before the agent ever runs, e.g. for a missing credential.
          if (noticeToCheck) {
            noticeToCheck = false;
            const issue = await api("GET", `/issues/${chat.id}`);
            if (issue.status === "blocked") {
              await write(`_(The chat is blocked in Paperclip; fix it there, then ask again. See ${chat.identifier ?? chat.id}.)_`);
              return { stopReason: "end_turn" };
            }
          }
          if (runIds.size > 0) {
            const checked = runIds.size;
            const runs = await Promise.all([...runIds].map((id) => api("GET", `/heartbeat-runs/${id}`)));
            if (runs.every((run) => TERMINAL_RUN_STATUSES.has(run.status))) {
              // A run can post its last comment and finish between the two calls above.
              await streamNewReplies();
              if (runIds.size === checked) {
                const unsuccessful = runs.find((run) => run.status !== "succeeded");
                if (unsuccessful) {
                  await write(`_(${agentRef} run ${unsuccessful.status.replace("_", " ")}; see ${chat.identifier ?? chat.id} in Paperclip.)_`);
                }
                return { stopReason: "end_turn" };
              }
            }
          }
          failures = 0;
        } catch (error) {
          if (!(error instanceof PaperclipRequestError) || ++failures >= MAX_POLL_FAILURES) throw error;
        }
        if (now() - started >= turnTimeoutMs) {
          const minutes = Math.round(turnTimeoutMs / 60000);
          const where = `Check ${chat.identifier ?? chat.id} in Paperclip or ask again later.`;
          await write(
            replies > 0
              ? `_(${agentRef}'s run is still running after ${minutes} min; later replies will not show here. ${where})_`
              : `_(No reply yet after ${minutes} min; ${agentRef} may still be working. ${where})_`,
          );
          return { stopReason: "end_turn" };
        }
        await sleep(pollMs, abort.signal);
      }
    },

    async cancel({ sessionId }) {
      sessions.get(sessionId)?.abort?.abort();
    },
  };
}

function main() {
  const options = loadConfig();
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  new acp.AgentSideConnection((connection) => createBridgeAgent(connection, options), stream);
}

// realpath so the check also holds when started through an npm bin symlink.
function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (startedDirectly()) main();
