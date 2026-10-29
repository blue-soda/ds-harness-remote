## Compatibility

**Breaking change notice:** Plugin `0.4.1` removes the earlier experimental
Remote business RPC surface (`sessions.*`, `session.*`, `permissions.respond`,
`sync.from`). Harness session traffic now only uses the official rc.2
`ApiProxy` or the v0.1.2 Typert Remote Gateway, and this plugin does not provide
an adapter or wire-format translation for the old RPC surface.

Plugin `0.4.28` targets DeepSeek Harness `dsh-v0.2.0-rc.2` and retains compatibility with `dsh-v0.1.7-rc.1`, while also supporting `dsh-v0.1.6-alpha.2` and earlier settings hosts. It supports `dsh-v0.1.1-rc.2` through the legacy
official `ApiProxy`, and `dsh-v0.1.2-alpha.1`–`rc.1` through the
official Typert Remote Gateway. It also supports
`dsh-v0.1.5-rc.1`, `dsh-v0.1.6-alpha.1`, and `dsh-v0.2.0-rc.2` Session V3 through the official Typert Remote
Gateway; a `0.1.6` Host reports patch `6` and therefore selects the same Session V3
profile with no wire-format adapter. A `0.4.13` Client running rc.2 remains compatible
with older rc.2 Hosts through the legacy capability fallback. `0.4.28` also reads the
running Harness version from the 0.2.0 Desktop shell's `@deepseek-ai/dsh-desktop-host`
entrypoint as well as from the CLI entrypoint, so Hosts started by the current Desktop app
keep reporting `harnessVersion` and the version-gated workspace compatibility paths
(legacy `workspaceFiles/changes`, byte-range reads) stay active.

Remote Web/Desktop and the Android app also normalize released sessions that
still report the retired `code` agent preset to `ptc`, so old sessions can
resume on `dsh-v0.1.5-rc.1` or `dsh-v0.1.6-alpha.1` without changing DeepSeek Harness itself.

Desktop endpoints must use a compatible Harness carrier. Plugin `0.4.28` selects the legacy
ApiProxy path for rc.2 Hosts when that Host exposes it, and Session V3 Desktop clients can open
legacy v0.1.2 Typert Remote Hosts through Remote-side history and event normalization. Legacy
Typert clients still reject Session V3 Hosts before switching the native UI or mutating a Workspace.

Beyond that matrix: `0.4.28` is verified on **`dsh 0.2.1-alpha.1`** (the current Desktop build),
where a remote Codex workspace opens across machines and loads its history, and its projection and
workspace-baseline fields satisfy what that release declares. The Codex-side baseline (App Server
**0.160.0**), the Windows path difference, the maintenance risks and the read-only checks to run
after either upstream is upgraded are recorded in
[Codex Remote technical notes](codex-remote.md).

`0.4.29` keeps the same compatibility targets and adds the Windows state-file retry described in the changelog.

`0.5.0` keeps the same carrier generations (rc.2 `ApiProxy`; v0.1.2 alpha.1-rc.1, v0.1.5 rc.1, v0.1.6 alpha.1 and v0.2.0 rc.1 Session V3 Typert Remote) and changes recovery instead: every kind of loss now shares one ladder (ten-second quick window over Relay with the view kept, local fallback at the ten-second mark, then a bounded 5/10/20/30s schedule that gives up for good), recovery restores the same session (device + workspace kind + directory), the user's own cancel or workspace choice wins over a recovery that lands later, and the Codex domain states its availability with `codex.app.capability` only when it really changes - so switching Codex off no longer disturbs a Harness session on the same connection. Devices hold one identity (`role` exists only on a connection).

`0.5.1` keeps the same carrier generations and the same recovery ladder, and changes who may sign in: only the browser authorization the user just completed registers this device, and being signed out is reported as a state rather than as an error (the panel answers it with the sign-in button and no error text). Codex is **off by default** and is switched on in the DeepSeek Remote settings card, where the switch applies immediately; an install that already had it on keeps it on, because the plugin's switch writes the home-level patch, which is applied after the bundle's.

`0.5.2` changes nothing outside the Remote status pill's CSS: on narrow screens it is centred on the viewport and shares the header's centre line instead of sitting lower and further right. Install pins move to `0.5.2`; everything in `0.5.1` above still applies.

`0.5.3` changes no wire format either: the credential-refresh lock now records its owner and is reclaimed when that process is gone (a lock with no owner is reclaimed after ten minutes), where it used to sit forever and block every later sign-in with `SERVER_CREDENTIALS_BUSY`. A live instance - including a suspended one - is still never preempted, so the one-use refresh token stays protected. Everything above still applies.

`0.5.4` changes no wire format: a connection displaced by another instance (`CONNECTION_REPLACED`, Server code `4003`) is no longer terminal. It logs that it is standing by and retries every five minutes (`reconnect.replacedRetryMs`, default `300000`) instead of stopping forever, so the device comes back once the other instance leaves. Everything above still applies.


0.5.5 changes no wire format: the plugin's Server authorization now follows DSH's DeepSeek session in both directions (signed in on DSH authorizes the device; signed out on DSH signs it out and disconnects), throttled to one reconciliation per ten seconds. Account creation stays a Server-side setting; accounts are matched by platform id. Everything above still applies.

