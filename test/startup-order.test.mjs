// Guards the startup-order invariant documented in src/index.ts main():
//
//     the stdio transport must connect BEFORE any network I/O.
//
// initializeCredentials() must stay fire-and-forget AFTER server.connect(), never
// awaited before it. Awaited first, a slow oauth2.googleapis.com at spawn time times
// out Claude Code's MCP registration and the session loses EVERY tool from this
// server — not just the authenticated ones. tools/list needs no credentials; handlers
// call ensureValidToken() lazily.
//
// Why this test exists rather than only health-check.mjs: nothing schedules that
// script, so it detects a regression only when someone remembers to run it. A
// startup-order regression is introduced by a code edit, and `npm test` runs at
// exactly that moment. This repo had no test suite at all before this file.
//
// How it detects the reorder without depending on how slow Google happens to be:
// the child gets an EXPIRED credential (forcing a token refresh) and an HTTPS proxy
// pointed at a black hole — a local socket that accepts the connection and then never
// answers. Correct order: connect returns immediately, `initialize` is answered in
// milliseconds, and the doomed refresh hangs harmlessly in the background. Broken
// order: the process is stuck awaiting a refresh that will never complete, so
// `initialize` is never answered and this test fails on its budget.
//
// Fully hermetic — HOME is redirected to a temp dir, so the real
// ~/.config/google-tasks-mcp/credentials.json is neither read nor written, and no packet
// leaves the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_LABEL = "google-tasks";                    // matches the server's own stderr line
const CONFIG_DIR = "google-tasks-mcp";                  // ~/.config/<CONFIG_DIR>/credentials.json
const MCP_BIN = fileURLToPath(new URL("../build/index.js", import.meta.url));

// Budgets are deliberately loose: this test asserts an ORDER, not performance. A
// correctly-ordered server answers in single-digit ms even on a loaded machine; a
// wrongly-ordered one hangs forever. Nothing lands in between, so a slow CI box
// cannot make this flaky.
const INITIALIZE_BUDGET_MS = 4000;
const STDIO_CONNECT_BUDGET_MS = 1000;

/** A socket that accepts connections and never replies — an unreachable Google. */
function startBlackhole() {
  const held = [];
  const srv = createServer((sock) => { held.push(sock); }); // accept, answer nothing
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      resolve({
        port: srv.address().port,
        close: () => { for (const s of held) s.destroy(); srv.close(); },
      });
    });
  });
}

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), "mcp-startup-order-"));
  await mkdir(join(home, ".config", CONFIG_DIR), { recursive: true });
  await writeFile(
    join(home, ".config", CONFIG_DIR, "credentials.json"),
    JSON.stringify({
      // Not secrets. Deliberately non-functional placeholders; the point is that a
      // refresh is ATTEMPTED, not that it succeeds.
      access_token: "fake-access-token-startup-order-test",
      refresh_token: "fake-refresh-token-startup-order-test",
      scope: "https://www.googleapis.com/auth/tasks",
      token_type: "Bearer",
      expiry_date: 1, // 1970 — long expired, so a refresh is forced at startup
    }),
    { mode: 0o600 },
  );
  return home;
}

test("stdio transport connects before any network I/O (startup-order invariant)", async (t) => {
  const blackhole = await startBlackhole();
  const home = await fakeHome();
  t.after(() => blackhole.close());

  const child = spawn("node", [MCP_BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      // Route every outbound HTTPS call into the black hole. google-auth-library
      // (via gaxios) honours these.
      HTTPS_PROXY: `http://127.0.0.1:${blackhole.port}`,
      https_proxy: `http://127.0.0.1:${blackhole.port}`,
      NO_PROXY: "",
      no_proxy: "",
      GOOGLE_CLIENT_ID: "startup-order-test.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "startup-order-test-not-a-real-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:3900/oauth2callback",
    },
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });

  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  const t0 = Date.now();
  const answered = new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 0) resolve(Date.now() - t0);
        } catch { /* not our frame */ }
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early (code ${code}); stderr: ${stderr}`)));
    setTimeout(
      () => reject(new Error(
        `no initialize response in ${INITIALIZE_BUDGET_MS}ms — the server is blocked on ` +
        `network I/O before server.connect(). This is the startup-order invariant ` +
        `(src/index.ts main()); stderr so far: ${stderr || "(silent)"}`,
      )),
      INITIALIZE_BUDGET_MS,
    ).unref?.();
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "startup-order-test", version: "1.0" },
    },
  }) + "\n");

  const elapsed = await answered;
  assert.ok(
    elapsed < INITIALIZE_BUDGET_MS,
    `initialize answered in ${elapsed}ms, budget ${INITIALIZE_BUDGET_MS}ms`,
  );

  // Second, independent reading of the same invariant: the server times this itself,
  // from the top of main() to immediately after connect. Any pre-connect await
  // inflates it even when the network is fast — which a wall-clock budget alone
  // would miss.
  const m = stderr.match(new RegExp(`${SERVER_LABEL} MCP stdio connected in (\\d+)ms`));
  assert.ok(m, `server never logged its stdio-connect timing; stderr: ${stderr || "(silent)"}`);
  assert.ok(
    Number(m[1]) < STDIO_CONNECT_BUDGET_MS,
    `stdio connected in ${m[1]}ms, budget ${STDIO_CONNECT_BUDGET_MS}ms — something ran before server.connect()`,
  );
});
