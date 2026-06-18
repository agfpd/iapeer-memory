/**
 * Test preload (wired via bunfig.toml [test].preload — BOTH the repo root and
 * package/ carry one, so raw `bun test` from either cwd is covered).
 *
 * HARD FUSE: verify-repair tests spawned the
 * real `iapeer` and registered crashlooping temp-path watcher triggers with
 * the LIVE notifier — /tmp tmux sockets are host-global, so no sandbox env
 * contains a real send. iapSend (src/watcher.ts) refuses while this env is
 * set; tests that need the spawn path inject a fake bin AND clear the var
 * locally.
 */
process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND = "1";
// Second belt: a test helper STRIPPED all
// IAPEER_MEMORY_* env before spawning the CLI — the fuse died with it (only
// the IAPEER_ROOT sandbox stopped real sends). The ecosystem-wide sandbox
// var survives such stripping; iapSend honours BOTH.
process.env.IAPEER_TEST_SANDBOX = "1";

// П7 (deny-by-default §4): the TEST default MCP port must never be the
// production 8766 — a sandboxed status/memoryd probe on the default port
// would see the HOST's live daemon (live precedent, 0.1.6). Deterministic
// per-worker derivation; explicit per-test ports keep winning.
if (!process.env.IAPEER_MEMORY_MCP_PORT) {
  process.env.IAPEER_MEMORY_MCP_PORT = String(18000 + (process.pid % 4000));
}
