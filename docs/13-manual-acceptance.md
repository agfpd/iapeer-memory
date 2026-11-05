# 13 — Isolated installed acceptance

These are manual macOS probes, not part of `bun test`. Run from the checkout
of the candidate tag. They never restart the host's services or write the real
vault. Use a **new** artifacts directory for every run.

## OC09: native OpenCode and a second runtime

```sh
bun scripts/proof-memory.ts --artifacts dist/proofs/pm-oc09-$(date +%s)
```

Defaults: installed `~/.local/bin/iapeer`, `~/.local/bin/iapeer-memory`,
`~/.opencode/bin/opencode`, and `~/.local/bin/claude`. Override with
`--core-bin`, `--memory-bin`, `--opencode-bin`, `--claude-bin`.
`--seed-config` names an OpenCode SDK cache (default `~/.config/opencode`);
only `node_modules`, `package.json`, and `package-lock.json` are copied,
not provider configuration, plugins or credentials.

Success means exit 0 and `result.json` → `success: true`, with all checks true:

- The sandbox profile compiles, denies reading the host registry, and rejects
  an external connection with the kernel's `Operation not permitted`. Native
  processes and hook children can read the synthetic root and named binaries;
  outbound network is restricted to the local host. The external negative
  control attempts a denied TCP connection to `1.1.1.1:443`, not an API call.
- Installed core creates `ocmem`; provider birth creates private surfaces and
  memoryd renders its paths/author-index without a subsequent vault edit or
  `verify`. A second synthetic peer supplies a valid non-self sender.
- Native OpenCode wakes under the real supervisor. A random code, absent from
  the provider's tool-call arguments, travels through real memory MCP search
  to native `write` and `edit`. Hooks stamp `author` and `last_edited_by` as
  `ocmem`; the native journal records all three tools.
- After the updated author index appears, the same personality launches in
  native Claude. Its MCP search reports `caller_agent: ocmem`; native Read/Edit
  changes the same note. The guide and refreshed author index reach Claude,
  and authorship remains the personality, not the runtime name.
- Explicit provider unprovision and repeated unprovision remove only OpenCode
  memory files, preserving the foreign `opencode.json`.

`raw/`, `wire.json`, `cli.json` and binary hashes in `result.json` are evidence.
SDK dependencies and sockets are excluded from `raw/`. The temporary root and
only the probe's two supervisors/daemons are cleaned up. A deterministic local
provider drives tool selection; this proves native integration, not cloud-model
reasoning. It does not replace PM acceptance, a native Codex cycle, or all three
full fleet lifecycle cycles.

## Release-source installer/signature gate

```sh
bun scripts/proof-signing.ts --artifacts dist/proofs/pm-signing-$(date +%s)
```

This first requires an **existing** `iapeer Local Codesign` identity. It retains
the operator's HOME solely so the normal signer can access that login keychain;
all product paths and installations point to a disposable root. No new identity
is created by the probe's setup. It runs only `install-binary`, never service
installation, update, verify, memoryd or fleet provisioning.

The normal CLI installer compiles and signs a temporary destination twice.
Strict verification and execution must pass without manual re-signing. The
designated requirement must name `com.agfpd.iapeer-memory` and the existing
identity's certificate leaf, and must remain unchanged across reinstall.

The negative case drives the same artifact's `installBinary` with real egress,
but truncates the successful compiler's temporary output to 64 bytes before
the real signer sees it. Real codesign must reject it. The preceding binary's
bytes/mode, signature and execution must survive, with no candidate files left.
This is fault injection at compiler output, **not** a mocked signature result
or an end-to-end malformed npm archive. The host's installed memory binary is
hashed before and after and must remain unchanged.

To test exact release archives before publication, install the two accepted
tgz files in a disposable dependency tree (substitute their absolute paths):

```sh
PROOF=$(mktemp -d)
cat > "$PROOF/package.json" <<EOF
{"private":true,"dependencies":{
  "@agfpd/iapeer-memory":"file:/ABS/FACADE.tgz",
  "@agfpd/iapeer-memory-core":"file:/ABS/CORE.tgz"
},"overrides":{"@agfpd/iapeer-memory-core":"file:/ABS/CORE.tgz"}}
EOF
(cd "$PROOF" && bun install)
bun scripts/proof-signing.ts \
  --source "$PROOF/node_modules/@agfpd/iapeer-memory" \
  --artifacts dist/proofs/pm-release-signing-$(date +%s)
rm -rf "$PROOF"
```

Verify `SHA256SUMS` first. The dependency override selects the accepted local
core bytes, not an unpublished registry pin; neither archive is rewritten.
The script itself is taken from the same git tag as the archives. Keep the
command output and `result.json`; compilation yields host-specific Mach-O bytes,
so these are separate from the npm archive hashes used for CI publication.
