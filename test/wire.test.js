const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { line, readOne, check } = require("../mcp-check.js");

function json(part) {
  return JSON.parse(part.msg.toString("utf8"));
}

test("one line", () => {
  const msg = { jsonrpc: "2.0", id: 1, result: { ok: true } };
  const got = readOne(line(msg));

  assert.deepEqual(json(got), msg);
  assert.equal(got.rest.length, 0);
});

test("split line", () => {
  const buf = line({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  const cut = buf.length - 2;

  assert.equal(readOne(buf.subarray(0, cut)), null);

  const got = readOne(Buffer.concat([buf.subarray(0, cut), buf.subarray(cut)]));
  assert.equal(json(got).id, 2);
});

test("two lines", () => {
  const a = { jsonrpc: "2.0", id: 1, result: {} };
  const b = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "ping" }] } };
  const got = readOne(Buffer.concat([line(a), line(b)]));

  assert.deepEqual(json(got), a);
  assert.deepEqual(json(readOne(got.rest)), b);
});

test("utf8 line", () => {
  const msg = { jsonrpc: "2.0", id: 3, result: { name: "測試" } };
  const got = readOne(line(msg));

  assert.deepEqual(json(got), msg);
});

test("crlf line", () => {
  const msg = { jsonrpc: "2.0", id: 4, result: { tools: [{ name: "spike" }] } };
  const got = readOne(Buffer.from(`${JSON.stringify(msg)}\r\n`, "utf8"));

  assert.deepEqual(json(got), msg);
});

test("bad line", () => {
  const got = readOne(Buffer.from("\n"));

  assert.equal(got.err, "blank line");
});

test("quiet server doesn't hang forever", { timeout: 3000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-check-"));
  const server = path.join(dir, "server.js");

  fs.writeFileSync(
    server,
    `#!/usr/bin/env node
setTimeout(() => process.exit(0), 1000);
process.stdin.resume();
`
  );

  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`;
  const cli = spawn(process.execPath, [path.join(__dirname, "..", "mcp-check.js"), cmd], {
    env: { ...process.env, MCP_CHECK_TIMEOUT: "50" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let err = "";
  cli.stderr.on("data", (chunk) => {
    err += chunk.toString("utf8");
  });

  try {
    const code = await new Promise((resolve, reject) => {
      cli.once("error", reject);
      cli.once("close", resolve);
    });

    assert.equal(code, 1);
    assert.match(err, /timed out/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("talks to a tiny server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-check-"));
  const server = path.join(dir, "server.js");

  fs.writeFileSync(
    server,
    `#!/usr/bin/env node
const { stdin, stdout } = process;
let buf = Buffer.alloc(0);

function readLines() {
  for (;;) {
    const nl = buf.indexOf(10);
    if (nl === -1) return;

    let end = nl;
    if (end > 0 && buf[end - 1] === 13) end -= 1;

    const raw = buf.subarray(0, end).toString("utf8");
    buf = buf.subarray(nl + 1);
    if (!raw) continue;

    const msg = JSON.parse(raw);

    if (msg.method === "initialize") {
      stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { capabilities: {} }
      }) + "\\n");
      continue;
    }

    if (msg.method === "tools/list") {
      stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "ping" }] }
      }) + "\\n");
    }
  }
}

stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  readLines();
});
stdin.resume();
`
  );

  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`;
  const cli = spawn(process.execPath, [path.join(__dirname, "..", "mcp-check.js"), cmd], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  cli.stdout.on("data", (chunk) => {
    out += chunk.toString("utf8");
  });
  cli.stderr.on("data", (chunk) => {
    err += chunk.toString("utf8");
  });

  const code = await new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", resolve);
  });

  try {
    assert.equal(code, 0, err);
    const lines = out.trim().split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s));

    assert.equal(lines.length, 2, out);
    assert.equal(lines[0].id, 1);
    assert.equal(lines[1].id, 2);
    assert.deepEqual(lines[1].result.tools, [{ name: "ping" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check: good replies pass", () => {
  assert.ok(check('{"jsonrpc":"2.0","id":1,"result":{}}', 1).msg);
  assert.ok(check('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}', 2).msg);
});

test("check: log line is skipped", () => {
  const got = check('{"jsonrpc":"2.0","method":"notifications/message","params":{}}', 1);
  assert.equal(got.skip, true);
});

test("check: bad replies fail", () => {
  assert.match(check("hello", 1).err, /not json/);
  assert.match(check("null", 1).err, /not json-rpc/);
  assert.match(check('{"jsonrpc":"2.0","id":5,"result":{}}', 1).err, /expected id 1/);
  assert.match(check('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"nope"}}', 1).err, /nope/);
  assert.match(check('{"jsonrpc":"2.0","id":1}', 1).err, /no result/);
  assert.match(check('{"jsonrpc":"2.0","id":2,"result":{}}', 2).err, /tools array/);
});

// one fake server, mode pick what kind of rubbish it send back for every request
const badServer = `#!/usr/bin/env node
const mode = process.argv[2];
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const raw of lines) {
    const msg = JSON.parse(raw);
    if (msg.id === undefined) continue;
    let reply = "";
    if (mode === "garbage") reply = "hello not json";
    if (mode === "error") reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "nope" } });
    if (mode === "wrong-id") reply = JSON.stringify({ jsonrpc: "2.0", id: 99, result: { tools: [] } });
    process.stdout.write(reply + "\\n");
  }
});
process.stdin.resume();
`;

const expectErr = {
  garbage: /not json/,
  error: /server error: nope/,
  "wrong-id": /expected id 1, got 99/,
};

for (const mode of ["garbage", "error", "wrong-id"]) {
  test(`cli fails on ${mode} reply`, { timeout: 3000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-check-"));
    const server = path.join(dir, "server.js");
    fs.writeFileSync(server, badServer);

    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(server)} ${mode}`;
    const cli = spawn(process.execPath, [path.join(__dirname, "..", "mcp-check.js"), cmd], {
      env: { ...process.env, MCP_CHECK_TIMEOUT: "2000" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let err = "";
    cli.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8");
    });

    try {
      const code = await new Promise((resolve, reject) => {
        cli.once("error", reject);
        cli.once("close", resolve);
      });

      assert.equal(code, 1, err);
      assert.match(err, expectErr[mode]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
