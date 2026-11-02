# Changelog

## 0.5.0

- Library: the anon trace records what the proxy sends to the provider **after** the pipeline and what the model answers **before** restore, so a reviewer can check that no clear-text personal data reached the provider. `TransformProxyOptions.trace?: TraceSink` (synchronous `record(event: TraceEvent)`) gets one `request` line per proxied request on the wire routes and exactly one `response` or `error` line for it, linked by `requestId`. Without `trace`, nothing is recorded or hashed. A sink that throws is logged (`transform proxy: trace sink failed: <msg>`) and never reaches the client.
- Library: a `request` line holds only the delta: the entries of the rewritten body not yet traced in this session, keyed by JSON path (`messages[i]` / `input[i]` per element, every other top-level key such as `system`, `tools`, `instructions` as a whole; `{}` when nothing is new). The harness resends the whole history each round, so a full body per line would repeat the conversation. `dropSession` forgets what was traced.
- Library: a `response` line holds the reply before restore: the parsed JSON body, or for SSE the message the walker assembles in the protocol's non-streamed shape (Anthropic text, thinking, redacted thinking and `tool_use` blocks with parsed `input`; OpenAI chat `chat.completion` with content, reasoning and tool calls; OpenAI responses the final `response` object). The SSE bytes to the client are the same with or without a trace. A stream that ends before a complete reply still gets its line, with no `content`. A non-2xx reply gives an `error` line with the status and the body cut to 4096 characters; an unreachable upstream gives `status: 502` and the fetch error.
- Library: `createFileTraceSink({ dir, maxChars? })` appends one JSON line per event to `<dir>/<sessionId>.jsonl` (an id outside `[A-Za-z0-9_-]{1,128}` becomes `sha256-<32 hex>`). The directory is created with mode 0700, files with 0600: they hold exactly the leaks the trace is meant to find. `serializeTraceEvent(event, maxChars?)` is the line format; `content` whose JSON is longer than `maxChars` (default `DEFAULT_TRACE_MAX_CHARS`, 262144) becomes that JSON text cut to `maxChars`, with `truncated: true`.
- Library: trace lines name the route: `anthropic.messages`, `anthropic.count_tokens`, `openai.chat` or `openai.responses`.
- Library: an always-on leak check scans every string value of the rewritten body, including fields no transform sees (`tools`, metadata, unknown fields), for known originals: the session's facts (source = publisher id) and the originals the pipeline has already replaced (`Transform.knownOriginals`, source `pipeline`). A value that one place replaced but another sends in clear text (a name in a tool description, or one the detector missed in a new context) is otherwise invisible. Matching is case-sensitive; values shorter than 3 characters are skipped (chance hits). A finding logs `log.warn('transform proxy: known original sent upstream', { sessionId, route, leaks })` with kind, source and JSON path of each finding, never the value, and goes into the `request` line's `leaks`. The request is still sent: the check warns, it does not block.
- Library: `Transform.knownOriginals?()` returns the originals an instance has already replaced in this session, each with its kind (forge-anon: its mapping). Without connectors (omp) there are no facts, so the leak check needs these to compare against. `composeTransforms` returns the union of all stages; a stage whose `knownOriginals()` throws is logged and skipped. The values are used only by the leak check and never sent or logged.
- Config: top-level key `trace: { dir, maxChars? }` in `transform-proxy.yaml`; `dir` resolves against the config file's directory, `maxChars` must be a positive integer.
- CLI: `--trace-dir <dir>` (relative to the cwd) turns the file trace on; `SKAILE_TRANSFORM_PROXY_TRACE_DIR` (relative to the cwd) overrides the flag and the config's `trace.dir`. With a trace, the CLI prints `[transform-proxy info] trace: <dir>` on stderr at start.
- CLI, **behaviour change**: log lines print non-string arguments as JSON (`JSON.stringify`) instead of `String(arg)`, so the leak warning reads `[transform-proxy warn] transform proxy: known original sent upstream {"sessionId":"…","route":"…","leaks":[…]}` instead of `[object Object]`. Anything that parses the proxy's stderr sees JSON where it saw `[object Object]` before.
- omp extension: `/anon status` shows `trace: <dir>` or `trace: off`. The own proxy child inherits `SKAILE_TRANSFORM_PROXY_TRACE_DIR`; without it, the status shows the config's `trace.dir`. With an external proxy (`SKAILE_TRANSFORM_PROXY_URL`) only the env var is known.
- omp extension: the extension keeps reading its proxy child's stderr after `listening <url>` (before, it dropped it) and turns each leak warning into a warning notice, once per session and kind for the child's life: `anon: a known <kind> value was sent to the provider in clear text (at <path>, route <route>). Value not shown.` Before, the warning was lost, and repeating it every round would flood the UI.

## 0.4.0

- Library: `TransformProxy.inspect(sessionId, pipelineId?)` returns host-only transform state, `{ <transformId>: state }` for each stage of the session's pipeline instance (default `defaultPipeline`) that implements the new optional `Transform.inspect?()`. A host such as anon-ai reads forge-anon's mapping through it to show what was anonymized. It is in-process only (no HTTP route, never sent), returns `{}` for an unknown session, an unbuilt pipeline or a failed build, and never builds an instance or creates session state.

## 0.3.1

- Anthropic walker: the system text that Anthropic's Claude subscription (OAuth) check reads verbatim passes untransformed: the leading Claude Code identity sentence and the leading `x-anthropic-billing-header:` line. The rest of each block is still transformed. forge-anon read `Claude` as a name and the `cc_version` as IP addresses, so every request of a subscription session with anon on got 429 `rate_limit_error` "Error".

## 0.3.0

- omp extension, **behaviour change**: `/anon on` and `/anon off` switch only the omp process they run in (its subagents and its `/new`, `/resume`, `/fork` sessions included) and no longer save the default. Before, every `/anon on|off` wrote `~/.omp/agent/skaile-transform-proxy.json`, so turning anon off in one window turned it off for every omp started later. `/anon on --global` and `/anon off --global` also save the default. A saved `on` is applied at session start only until the first successful `/anon on|off` in that process, so a plain `/anon off` stays off across `/new`. An existing saved `enabled: true` still turns anon on in new omp processes; run `/anon off --global` to clear it.

## 0.2.6

- omp extension: while anon is on, in error or required, images are not sent. The extension sets omp's `images.blockImages` as a runtime override (never persisted), so omp replaces every image in the request, history included, with `Image reading is disabled.`; `/anon off` drops the override. Before, a screenshot from a browser tool made the proxy refuse every later request of the session with 400 `unsupported_content` ("Anthropic image content cannot be transformed"). `/anon status` lists `images: not sent`. An omp without the settings registry gets one warning, and the proxy keeps refusing images.

## 0.2.5

- omp extension: the status is `🟢A` (on), `🔴A` (off), `🟠A` (error) instead of `A`, `Ⱥ`, `A!`. The crossed A was not legible in common terminal fonts, and omp strips ANSI colour from extension statuses, so the colour comes from an emoji.

## 0.2.4

- omp extension: the status is one glyph instead of a word: `A` (on), `Ⱥ` (crossed A, off), `A!` (error; was `anon on`, `anon off`, `anon error`). It fits omp's `status` status-line segment; the README shows the `statusLine` config that puts it into the main line.

## 0.2.3

- omp extension: without `SKAILE_TRANSFORM_PROXY_URL`, `/anon on` starts the proxy as a child process under the system Node (`SKAILE_TRANSFORM_PROXY_NODE`, else `node` from `PATH`; Node ≥ 22) instead of inside omp. omp is a compiled Bun executable whose resolver cannot load transform modules with native or ML dependencies from `node_modules`: under omp 18.14.2, `/anon on` failed with `transform "anon": cannot load module @skaile/forge-anon/proxy: Cannot find package 'ibantools'`. The child runs this package's CLI with the found config, `--port 0 --host 127.0.0.1 --exit-with-stdin` and a random token, which every routed provider sends as `x-skaile-transform-token`. A child that exits before `listening <url>` or stays silent for 60 s fails `/anon on` with its last stderr lines (token redacted). The child exits with omp, does not keep omp's event loop alive, and is replaced on the next turn when it dies. A rotated-out proxy session is no longer dropped: the child keeps its state in memory until it exits, and no request carries that id again.
- CLI: `--exit-with-stdin` stops the proxy when its stdin closes, so a parent that spawns it with a stdin pipe takes it down on exit, SIGKILL included.

## 0.2.2

- Fail closed on malformed request bodies: the Anthropic, OpenAI chat and OpenAI responses walkers refuse a JSON body whose shape they cannot classify (a root that is not an object; a `system`, `messages`, `input`, `instructions`, message `content`, text, thinking, tool-call `arguments` or tool-result slot of an unexpected type) with 400 `unsupported_content` instead of forwarding it untransformed. Unknown part, block and item types still pass through.
- Upstream response `content-type` is matched case-insensitively, so `Text/Event-Stream` and `Application/JSON; charset=utf-8` replies are restored instead of relayed with placeholders.
- omp extension: a failed rebind of the active model is an activation failure. `/anon on` rolls the routes back, persists nothing and stays `anon off`; in required mode, or when a later turn's rebind fails, the footer shows `anon error`. While anon is on or in error, a `before_provider_request` handler replaces the payload of any request whose model bypasses the proxy with an empty object (omp has no hook that cancels a provider request).
- omp extension: the proxy session follows the root omp session. On `session_switch` (`/new`, `/resume`, `/fork`) and on a root `session_start` with a new id, every provider is re-routed with the new `x-skaile-transform-session`, and the in-process proxy drops the old session; headless `print` sessions (subagents) keep the parent's id.

## 0.2.1

- Anthropic walker: the pipeline `instruction` is appended after the host's system prompt (last text block, or after a blank line for a string `system`) instead of being prepended. Claude Code gateways such as TeamClaude answer 429 `rate_limit_error` for Sonnet when the system prompt does not start with the Claude Code blocks; with the instruction first, omp and Claude Code requests for `claude-sonnet-4-5` through the proxy were refused.

## 0.2.0

- OpenAI chat completions (`/chat/completions`) and OpenAI responses (`/responses`) walkers: text leaves, tool-call arguments and reasoning summaries are transformed outbound and restored in JSON and SSE replies; `image_url`, `input_audio`, `file`, `input_image` and `input_file` parts are refused with 400 `unsupported_content`. Responses reasoning summaries are cached by item id so a replayed reasoning item is sent back byte for byte.
- omp extension (`@skaile/transform-proxy/omp`, manifest `omp.extensions`): `/anon on|off|status` routes every provider of omp's model registry through the proxy (an external one from `SKAILE_TRANSFORM_PROXY_URL`, or one started in-process from the CLI config lookup), shows `anon on` / `anon off` in the footer, persists the flag in omp's agent dir and refuses `off` under `SKAILE_TRANSFORM_PROXY_MODE=required`.

## 0.1.0

- First release: transform contract, chain composition, per-session state and facts, the HTTP proxy with the Anthropic Messages walker, and the `skaile-transform-proxy` CLI.
