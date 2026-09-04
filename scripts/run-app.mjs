#!/usr/bin/env node
/**
 * `npm run app` — one command that starts the whole application.
 *
 * Every check below exists because it actually went wrong during
 * development, and each failed in a way that did not name its own cause:
 *
 *  - upstream added a dependency, and `tsc` failed with "Cannot find module
 *    '@playwright/test'" rather than "run npm install";
 *  - a branch switch left a stale `.next/types/validator.ts` referencing a
 *    deleted route, and typecheck failed on a file nobody wrote;
 *  - a dev server from hours earlier still held port 3000, so a "running"
 *    app was serving code from a different branch;
 *  - `.env.local` pointed at an empty database, and the app looked broken
 *    when it was merely unpopulated;
 *  - OPENROUTER_MODEL was unset, so every provider was skipped with
 *    `no_structured_output_capability` and intent extraction silently
 *    returned nulls.
 *
 * So this is a preflight, not a wrapper: it reports what is wrong and what
 * to do about it, then hands over to `next dev`. It never guesses — it will
 * not install, delete or kill anything without being asked (`--fix`).
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 3000);
const FIX = process.argv.includes("--fix");

const problems = [];
const notes = [];

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

function fail(what, why, howToFix) {
  problems.push({ what, why, howToFix });
  bad(`${what} — ${why}`);
}

// ---------------------------------------------------------------- 1. node
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  fail("Node version", `found v${process.versions.node}`, "Next.js 16 needs Node 20 or newer.");
} else {
  ok(`Node v${process.versions.node}`);
}

// ------------------------------------------------------------ 2. env file
const envPath = path.join(ROOT, ".env.local");
let env = {};
if (!existsSync(envPath)) {
  fail(".env.local", "not found", "Create it with at least DATABASE_URL=postgres://…");
} else {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.DATABASE_URL) {
    fail(".env.local", "DATABASE_URL is missing", "The app cannot retrieve anything without a database.");
  } else {
    ok(".env.local with DATABASE_URL");
  }

  // Not fatal, but the cause of a confusing silent failure, so it is named.
  if (env.OPENROUTER_API_KEY && !env.OPENROUTER_MODEL) {
    warn(
      "OPENROUTER_API_KEY is set but OPENROUTER_MODEL is not — every provider will be skipped\n" +
        "    (no_structured_output_capability) and product attributes will come back empty.\n" +
        "    Set one of: openai/gpt-4o-mini, openai/gpt-4o, openai/gpt-4-turbo.",
    );
    notes.push("Attribute extraction is disabled until OPENROUTER_MODEL is set.");
  } else if (env.OPENROUTER_MODEL) {
    ok(`LLM provider model: ${env.OPENROUTER_MODEL}`);
  } else {
    warn("No LLM provider configured — the app runs on deterministic retrieval only.");
  }
}

// -------------------------------------------------------- 3. dependencies
const installedLock = path.join(ROOT, "node_modules", ".package-lock.json");
if (!existsSync(path.join(ROOT, "node_modules"))) {
  if (FIX) {
    console.log("  … installing dependencies");
    execSync("npm install", { stdio: "inherit" });
    ok("dependencies installed");
  } else {
    fail("Dependencies", "node_modules is missing", "Run `npm install`, or re-run with --fix.");
  }
} else if (existsSync(installedLock) && existsSync(path.join(ROOT, "package-lock.json"))) {
  // A lockfile newer than what was installed is how "upstream added a
  // dependency" shows up before it becomes a confusing type error.
  const lockAt = statMtime(path.join(ROOT, "package-lock.json"));
  const installedAt = statMtime(installedLock);
  if (lockAt > installedAt) {
    if (FIX) {
      console.log("  … package-lock.json is newer than node_modules; installing");
      execSync("npm install", { stdio: "inherit" });
      ok("dependencies updated");
    } else {
      warn("package-lock.json is newer than node_modules — a dependency may be missing.\n    Run `npm install`, or re-run with --fix.");
    }
  } else {
    ok("dependencies up to date");
  }
} else {
  ok("dependencies present");
}

function statMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------- 4. stale build
const validator = path.join(ROOT, ".next", "types", "validator.ts");
if (existsSync(validator)) {
  const referenced = readFileSync(validator, "utf8").matchAll(/'\.\.\/\.\.\/(src\/app\/[^']+)\.js'/g);
  const missing = [...referenced]
    .map((m) => m[1])
    .filter((rel) => !existsSync(path.join(ROOT, `${rel}.tsx`)) && !existsSync(path.join(ROOT, `${rel}.ts`)));
  if (missing.length > 0) {
    if (FIX) {
      rmSync(path.join(ROOT, ".next"), { recursive: true, force: true });
      ok("cleared a stale .next build");
    } else {
      warn(`.next references ${missing.length} route(s) that no longer exist (e.g. ${missing[0]}).\n    This breaks typecheck. Run \`rm -rf .next\`, or re-run with --fix.`);
    }
  } else {
    ok("build cache consistent");
  }
}

// ------------------------------------------------------------- 5. the port
const portHolder = await whoHasPort(PORT);
if (portHolder) {
  if (FIX) {
    try {
      // Every pid on the port, not just the first: `npm run dev` spawns
      // next-server as a child, so killing the wrapper alone leaves the
      // real server holding the socket and the port never frees.
      execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: "ignore", shell: "/bin/sh" });
      // Killing the process does not release the socket synchronously —
      // spawning straight away raced it and next dev died with EADDRINUSE
      // while the port still looked taken. Wait for it to actually free.
      const freed = await waitForPortFree(PORT, 8000);
      if (freed) {
        ok(`freed port ${PORT} (was pid ${portHolder} and any child it spawned)`);
      } else {
        fail(`Port ${PORT}`, `pid ${portHolder} was killed but the port is still held`, "Wait a moment and try again.");
      }
    } catch {
      fail(`Port ${PORT}`, `held by pid ${portHolder} and could not be freed`, "Stop it manually.");
    }
  } else {
    fail(
      `Port ${PORT}`,
      `already in use by pid ${portHolder}`,
      `That may be an older server serving a different branch. Stop it (\`kill ${portHolder}\`), re-run with --fix, or set PORT.`,
    );
  }
} else {
  ok(`port ${PORT} is free`);
}

/** Polls until nothing answers on the port, or the deadline passes. */
async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await whoHasPort(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function whoHasPort(port) {
  const inUse = await new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => (socket.destroy(), resolve(true)));
    socket.on("error", () => resolve(false));
    setTimeout(() => (socket.destroy(), resolve(false)), 700);
  });
  if (!inUse) return null;
  try {
    return execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim().split("\n")[0] || "unknown";
  } catch {
    return "unknown";
  }
}

// --------------------------------------------------------------- 6. report
console.log();
if (problems.length > 0) {
  console.log("\x1b[31mCannot start.\x1b[0m\n");
  for (const p of problems) console.log(`  ${p.what}: ${p.why}\n    → ${p.howToFix}\n`);
  console.log("Re-run with `npm run app -- --fix` to fix what can be fixed automatically.\n");
  process.exit(1);
}

for (const n of notes) console.log(`\x1b[33mNote:\x1b[0m ${n}`);
console.log(`\nStarting the BIS Standards Navigator on http://localhost:${PORT}\n`);

const child = spawn("npx", ["next", "dev", "--port", String(PORT)], { stdio: "inherit", env: { ...process.env } });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
