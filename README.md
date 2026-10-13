# paperclip-paseo-bridge

Chat with a [Paperclip](https://github.com/paperclipai/paperclip) agent from [Paseo](https://paseo.sh).

The bridge is a small [ACP](https://agentclientprotocol.com) agent. Paseo starts it, and it relays your messages to Paperclip's **Agent Chat**. You talk to the same conversation you see on Paperclip's Chat screen, with no second model in between.

## How it works

For each message you send in Paseo, the bridge:

1. Opens (or reuses) your chat with the agent: `POST /api/companies/:company/chats/:agent`.
2. Posts your message as a chat comment: `POST /api/issues/:id/comments`.
3. Polls for new comments and streams each agent reply to Paseo as it appears.
4. Ends the turn once the reply's run finishes. If the run fails, or no reply arrives in time, it says so.

`/new` passes through to Paperclip, which resets the agent's session.

## Requirements

- Node 22 or newer, on the same machine as Paseo.
- A Paperclip server that this machine can reach, with **Agent Chat** turned on (Instance settings → Experimental).
- A Paperclip **board API key**, saved alone in a file only you can read.

## Install

```sh
git clone https://github.com/leixusam/paperclip-paseo-bridge.git ~/.local/share/paperclip-paseo-bridge
cd ~/.local/share/paperclip-paseo-bridge
npm ci
npm test   # optional
```

## Get a board key

The simplest route is Paperclip's own CLI: run `paperclipai connect`, choose the **board** persona, and approve the request in your browser. Save the key it prints into a file, then lock the file down:

```sh
mkdir -p ~/.paperclip && chmod 700 ~/.paperclip
nano ~/.paperclip/paseo-bridge-token   # paste only the key, on one line
chmod 600 ~/.paperclip/paseo-bridge-token
```

A board key acts as you. If Paperclip is on another machine, point `PAPERCLIP_API_BASE` at an `https://` address so the key is not sent in plain text. Keep it out of `~/.paseo/config.json` and out of git; the bridge only accepts a file path.

## Configure Paseo

Add a provider to `~/.paseo/config.json`, then run `paseo reload`:

```json
{
  "agents": {
    "providers": {
      "paperclip-chief-of-staff": {
        "extends": "acp",
        "label": "Chief of staff (Paperclip)",
        "command": ["/absolute/path/to/node", "/home/you/.local/share/paperclip-paseo-bridge/bridge.mjs"],
        "env": {
          "PAPERCLIP_API_BASE": "http://127.0.0.1:3100/api",
          "PAPERCLIP_BOARD_TOKEN_FILE": "~/.paperclip/paseo-bridge-token",
          "PAPERCLIP_COMPANY": "ACME",
          "PAPERCLIP_CHAT_AGENT": "chief-of-staff"
        }
      }
    }
  }
}
```

Use an absolute path to `node` (see `which node`), because Paseo may not start with your shell's `PATH`. Add one provider per agent you want to talk to.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PAPERCLIP_BOARD_TOKEN_FILE` | yes | File holding the board key. A leading `~/` is expanded. |
| `PAPERCLIP_COMPANY` | yes | Company id, or its issue prefix such as `ACME`. |
| `PAPERCLIP_CHAT_AGENT` | yes | Agent URL key (as in its Paperclip URL, e.g. `chief-of-staff`) or id. |
| `PAPERCLIP_API_BASE` | no | Defaults to `http://127.0.0.1:3100/api`. |
| `BRIDGE_POLL_MS` | no | How often to check for replies. Defaults to `2000`. |
| `BRIDGE_TURN_TIMEOUT_MS` | no | How long one turn may take, from your message until the agent's run finishes. Defaults to `1200000` (20 minutes). |

If something is missing or wrong, the bridge still starts, and your first message in Paseo fails with a list of what to fix.

## Limits

- Replies show up when the agent's run writes them. The bridge does not stream the run's internal steps.
- Cancelling in Paseo stops waiting, but the Paperclip run keeps going.
- A turn ends when the runs that wrote the replies finish. Replies posted after the turn's time limit stay in Paperclip and do not show in Paseo.
- Agent Chat is an experimental Paperclip feature, so its API may change.

## Remove

Delete the provider from `~/.paseo/config.json`, run `paseo reload`, delete the install folder, and revoke the board key in Paperclip.

## License

MIT
