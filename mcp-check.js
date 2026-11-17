#!/usr/bin/env node

const { spawn } = require("node:child_process");

function findLine(buf) {
  return buf.indexOf(10);
}

function line(msg) {
  return Buffer.from(`${JSON.stringify(msg)}\n`, "utf8");
}

function send(child, msg) {
  child.stdin.write(line(msg));
}

function readOne(buf) {
  const pos = findLine(buf);
  if (pos === -1) return null;

  let end = pos;
  if (end > 0 && buf[end - 1] === 13) end -= 1;
  if (end === 0) return { err: "blank line" };

  return {
    msg: buf.subarray(0, end),
    rest: buf.subarray(pos + 1),
  };
}

// last time anything not empty also count as pass, even rubbish or an error reply
function check(raw, id) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { err: `not json: ${raw.slice(0, 80)}` };
  }

  if (!msg || typeof msg !== "object") return { err: `not json-rpc: ${raw.slice(0, 80)}` };

  // server can send log / notification anytime, that one is not our answer
  if (msg.method) return { skip: true };

  if (msg.id !== id) return { err: `expected id ${id}, got ${msg.id}` };
  if (msg.error) return { err: `server error: ${msg.error.message || JSON.stringify(msg.error)}` };
  if (!msg.result) return { err: `no result for id ${id}` };
  if (id === 2 && !Array.isArray(msg.result.tools)) return { err: "tools/list did not give a tools array" };

  return { msg };
}

function run(cmd, opts = {}) {
  if (!cmd) {
    console.error('usage: node mcp-check.js "node server.js"');
    process.exit(1);
  }

  const child = spawn(cmd, {
    shell: true,
    stdio: ["pipe", "pipe", "inherit"],
  });

  let out = Buffer.alloc(0);
  let gotInit = false;
  let done = false;
  const timeoutMs = opts.timeoutMs || Number(process.env.MCP_CHECK_TIMEOUT || 5000);
  const timeout = setTimeout(() => {
    done = true;
    process.exitCode = 1;
    console.error("timed out waiting for server response");
    child.kill();
  }, timeoutMs);

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-check", version: "0.1.0" },
    },
  });

  child.stdout.on("data", (chunk) => {
    out = Buffer.concat([out, chunk]);

    for (;;) {
      const part = readOne(out);
      if (!part) return;

      if (part.err) {
        console.error(part.err);
        child.kill();
        process.exit(1);
      }

      out = part.rest;
      const raw = part.msg.toString("utf8");
      const got = check(raw, gotInit ? 2 : 1);

      if (got.skip) continue;
      if (got.err) {
        done = true;
        clearTimeout(timeout);
        console.error(got.err);
        child.kill();
        process.exit(1);
      }

      console.log(raw);

      if (!gotInit) {
        gotInit = true;
        send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
        send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        return;
      }

      done = true;
      clearTimeout(timeout);
      child.kill();
      return;
    }
  });

  child.on("exit", (code) => {
    clearTimeout(timeout);
    if (!done) process.exit(code || 1);
  });
}

if (require.main === module) {
  run(process.argv.slice(2).join(" "));
}

module.exports = { line, readOne, check };
