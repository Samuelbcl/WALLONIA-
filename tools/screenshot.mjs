#!/usr/bin/env node
/**
 * screenshot.mjs — capture fiable du moteur en Edge headless via CDP.
 * Attend que le chargement de tuiles soit stabilisé (window.wallonia) avant
 * de capturer, contrairement à --screenshot/--virtual-time-budget.
 *
 *     node tools/screenshot.mjs "http://localhost:5199/?alt=600" out.png
 */
import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "http://localhost:5199/";
const out = process.argv[3] ?? "shot.png";
// Chrome : le CDP d'Edge est bloqué sur cette machine (stratégie d'entreprise ?).
const BROWSER = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;

const browser = spawn(
  BROWSER,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(tmpdir(), "wallonia-cdp")}`,
    "--no-first-run",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--window-size=1600,900",
    url,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http"));
      if (page) return page;
    } catch {
      /* Edge pas encore prêt */
    }
    await sleep(500);
  }
  throw new Error("page CDP introuvable");
}

function cdp(ws) {
  let nextId = 1;
  const waiting = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

try {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });
  const send = cdp(ws);
  await send("Page.enable");
  await send("Runtime.enable");

  // Stabilisation : 4 lectures consécutives sans tuile en vol.
  let stable = 0;
  for (let i = 0; i < 240 && stable < 4; i++) {
    const res = await send("Runtime.evaluate", {
      expression:
        "window.wallonia ? window.wallonia.tilesInflight() + ':' + window.wallonia.tilesRendered() : 'boot'",
      returnByValue: true,
    });
    const val = res.result?.result?.value ?? "err";
    const [inflight, rendered] = String(val).split(":").map(Number);
    stable = inflight === 0 && rendered > 0 ? stable + 1 : 0;
    if (i % 8 === 0) console.log(`  ${val} (en vol:affichées)`);
    await sleep(500);
  }
  await sleep(700); // laisse les derniers uploads GPU passer

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log(`OK -> ${out}`);
} finally {
  try {
    execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* déjà mort */
  }
}
