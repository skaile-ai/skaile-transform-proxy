# @skaile/transform-proxy

A same-protocol passthrough HTTP proxy. A model client points its base URL at the proxy; the proxy runs every text leaf of the request through a chain of transforms (outbound), forwards the request with the client's own auth, and restores the reply (inbound), in JSON and in streamed SSE.

Anthropic in is Anthropic out. Only text fields are rewritten; everything else is forwarded byte for byte.

## Headers

| Header | Purpose |
|---|---|
| `x-skaile-transform-upstream` | Upstream base URL, for example `https://api.anthropic.com`. Required. |
| `x-skaile-transform-session` | Session id. Defaults to `default`. Transform state is kept per session. |
| `x-skaile-transform-pipeline` | Pipeline name. Defaults to `defaultPipeline`; without either, the request is refused. |
| `x-skaile-transform-token` | Client token. Required when a token is configured. |

The proxy strips all four headers before forwarding. Every other header, including `Authorization` and `x-api-key`, is relayed unchanged.

## Routes

| Path suffix | Handling |
|---|---|
| `POST …/messages` | Anthropic request and response: request rewritten, JSON reply and SSE stream restored. |
| `POST …/messages/count_tokens` | Request rewritten; the response passes through untouched. |
| `POST …/chat/completions` | OpenAI chat request and response: request rewritten, JSON reply and SSE stream restored. |
| `POST …/responses` | OpenAI responses request and response: request rewritten, JSON reply and SSE stream restored. |
| `GET …/models` | Passthrough. |
| anything else (embeddings included) | 404 `unsupported_route`. |

Embeddings are refused on purpose: a vector of pseudonymized input cannot be restored.

## Refusals

- Attachments (image, document, file parts) are refused with 400 `unsupported_content`. Nothing is sent upstream.
- A body that is not JSON is refused with 400 `invalid_json`. A JSON body whose shape the walker cannot classify is refused with 400 `unsupported_content`: a root that is not an object, or a `system`, `messages`, `input`, `instructions`, message `content`, text, thinking, tool-call `arguments` or tool-result slot of an unexpected type. Unknown part, block and item types still pass through untouched.
- Unknown routes, pipelines and upstreams are refused before any body is read or transform is built.
- A transform that throws refuses the request with 502 `transform_failed`. Nothing is sent upstream.
- Bedrock (SigV4 covers the body) and Vertex are not routed. Refuse them in the caller.
- A non-loopback `host` requires a token.
- `OPTIONS` is refused: 401 without a token, 405 with one.

Error bodies have the form `{ "error": { "type": "...", "message": "..." } }`.

## Configuration

```yaml
# .skaile/transform-proxy.yaml
transforms:
  anon:
    module: "@skaile/forge-anon/proxy"
    config: { config: anon.config.yaml }
pipelines:
  anon: [anon]
defaultPipeline: anon
allowUpstreams:            # optional; default: any https origin, plus loopback http
  - https://api.anthropic.com
trace:                    # optional; see "Trace"
  dir: anon-traces        # relative to this file's directory
  maxChars: 262144        # optional; positive integer, default 262144
```

Keys are exactly the option fields, except `trace`, which configures the CLI's file sink (see [Trace](#trace)). An unknown top-level key, or an unknown key under `trace`, is an error. Module specifiers resolve against the config file's directory.

## CLI

```sh
skaile-transform-proxy [--config <file>] [--port <n>] [--host <h>] [--token <t>] [--trace-dir <dir>] [--exit-with-stdin]
```

- The token comes from `--token` or `SKAILE_TRANSFORM_PROXY_TOKEN`.
- Without `--config`, the proxy reads `./.skaile/transform-proxy.yaml`, then `~/.config/skaile/transform-proxy.yaml`.
- On start it prints `listening <url>`. It stops on SIGINT or SIGTERM.
- `--exit-with-stdin` also stops it when its stdin closes. A parent process that spawns the proxy with a stdin pipe and never writes to it takes the proxy down when it exits, even on SIGKILL.
- `--trace-dir <dir>` (relative to the cwd) writes the [trace](#trace) there; `SKAILE_TRANSFORM_PROXY_TRACE_DIR` overrides it. With a trace, the CLI prints `[transform-proxy info] trace: <dir>` on stderr at start.
- Warnings and errors go to stderr as `[transform-proxy warn] <message>` / `[transform-proxy error] <message>`, followed by each argument: strings as they are, everything else as JSON.

## Library

```ts
import { createTransformProxy } from '@skaile/transform-proxy'

const proxy = await createTransformProxy({
  baseDir: process.cwd(),
  transforms: { anon: { module: '@skaile/forge-anon/proxy', config: { config: 'anon.config.yaml' } } },
  pipelines: { anon: ['anon'] },
  defaultPipeline: 'anon',
})
proxy.session('s1').publisher('connector.patients').publish([{ kind: 'NAME_PATIENT', value: 'Alice' }])
// ... clients use proxy.url with the headers above ...
await proxy.dropSession('s1')
await proxy.close()
```

`await proxy.inspect('s1')` lets the host read what the session's transforms hold, e.g. forge-anon's mapping for highlights: `{ <transformId>: state }`, one entry per stage of the pipeline (`inspect('s1', 'anon')`; default `defaultPipeline`) whose `Transform` implements `inspect()`. It is in-process only: there is no HTTP route, and the result is never sent anywhere. An unknown session, a pipeline that has not been built for the session yet, or a failed build gives `{}`; `inspect` never builds an instance or creates session state.

`trace: createFileTraceSink({ dir })` in the options turns on the [trace](#trace). Any object with a synchronous `record(event: TraceEvent)` is a `TraceSink`.

## Trace

The trace records what the proxy sends to the provider **after** the pipeline, and what the model answers **before** restore. It exists to check that no clear-text personal data reaches the provider.

Turn it on in one of three places; the first that is set wins:

1. `SKAILE_TRANSFORM_PROXY_TRACE_DIR=<dir>` (relative to the cwd; an empty value counts as unset)
2. `--trace-dir <dir>` (relative to the cwd)
3. `trace: { dir, maxChars? }` in `transform-proxy.yaml` (`dir` relative to the config file)

`maxChars` comes from the config only. In the library, pass `trace: createFileTraceSink({ dir, maxChars? })`, or any `TraceSink`.

`createFileTraceSink` writes one file per session, `<dir>/<sessionId>.jsonl`, and appends one JSON line per event. A session id outside `[A-Za-z0-9_-]{1,128}` becomes `sha256-` plus the first 32 hex characters of its sha256. The directory is created with mode 0700, the files with 0600. A sink that throws is logged (`transform proxy: trace sink failed: <msg>`) and does not change what the client gets.

Each proxied request on a wire route (`…/messages`, `…/messages/count_tokens`, `…/chat/completions`, `…/responses`) gives one `request` line, then exactly one `response` or `error` line. `GET …/models` is not traced. A line (`TraceEvent`) has these fields:

| Field | Content |
|---|---|
| `at` | ISO timestamp. |
| `requestId` | Random UUID per proxied request; links its request and response/error lines. |
| `sessionId` | The proxy session. |
| `pipeline` | The pipeline id. |
| `route` | `anthropic.messages`, `anthropic.count_tokens`, `openai.chat` or `openai.responses`. |
| `upstream` | The forward target, origin + path, without the query string. |
| `model` | The request body's `model`, when it is a string. |
| `phase` | `request`, `response` or `error`. |
| `status` | response/error: the HTTP status (502 when the upstream was unreachable). |
| `durationMs` | response/error: milliseconds since the request line. |
| `content` | See below. |
| `truncated` | `true` when `content` was cut. |
| `leaks` | request: the [leak check](#leak-check) findings (`[]` when none); response/error: `[]`. |

`content` by phase:

- `request`: only the delta, an object keyed by JSON path, e.g. `{ "messages[4]": {…}, "system": […], "tools": […] }`. Each element of `messages` and `input` is one entry (`messages[i]`, `input[i]`); every other top-level key of the rewritten body is one entry as a whole. An entry is written once per session: the proxy keeps a sha256 of each written entry, and a later request writes only the entries it has not seen, `{}` when nothing is new. Harnesses resend the whole history every round, so round two shows only the new turn. A harness that changes an earlier message (omp strips thinking blocks, for example) makes that message show up again. Placeholders are stable per session, so the hashes are too. `dropSession` forgets the hashes with the rest of the session.
- `response`: the reply before restore. A JSON reply is the parsed body. An SSE reply is the message the walker assembles from the stream, in the protocol's non-streamed shape: an Anthropic `message` with its text, thinking and `tool_use` blocks (`input` parsed from the streamed JSON), an OpenAI `chat.completion` with content, `reasoning_content` and `tool_calls`, or the `response` object of the final OpenAI responses event. The SSE bytes the client gets are the same with or without a trace. A stream that ends before a complete reply has no `content`.
- `error`: a non-2xx reply's body as text, cut to 4096 characters, or the fetch error when the upstream was unreachable.

When the JSON of `content` is longer than `maxChars` (default 262144, `DEFAULT_TRACE_MAX_CHARS`), `content` becomes that JSON text cut to `maxChars`, and `truncated` is `true`. `serializeTraceEvent(event, maxChars?)` gives the line without the trailing newline.

### Leak check

The leak check runs on every request on a wire route, with or without a trace. After the pipeline has rewritten the request, it scans every string value of the whole body, fields no transform sees included (`tools`, metadata, unknown fields), for known originals:

- the session's facts, with the publisher id as `source`;
- the originals the pipeline has already replaced in this session (`Transform.knownOriginals()`, e.g. forge-anon's mapping), with `source` `pipeline`. Without connectors (omp) there are no facts, so these are what the check compares against: a name that the transform replaced in one place and that appears in clear text in another, in a tool description or in a context the detector missed.

Matching is case-sensitive and by substring; values shorter than 3 characters are skipped, because they match by chance. Object keys are not scanned. Each finding has `kind`, `source` and `at` (the JSON path, e.g. `tools[0].description`), once per kind, source and path. A request with findings logs

```text
transform proxy: known original sent upstream { sessionId, route, leaks: [{ kind, source, at }] }
```

as a warning (the CLI prints `[transform-proxy warn] transform proxy: known original sent upstream {"sessionId":"…","route":"…","leaks":[…]}`), and the findings go into the request line's `leaks`. The warning never contains the value. The request is still sent: the check warns, it does not block.

Trace files contain exactly the leaks they are meant to find, in clear text. Keep them local, never commit them, and delete them once reviewed.

## omp extension

The package ships an [omp](https://omp.sh) extension (subpath `@skaile/transform-proxy/omp`, declared in the package manifest under `omp.extensions`):

```sh
omp plugin install @skaile/transform-proxy
```

It adds the command `/anon on|off [--global] | status` and a compact status: `🟢A` (on), `🔴A` (off) or `🟠A` (error). The colour is in the emoji because omp strips ANSI colour from extension statuses and draws them in its accent colour. Unless `SKAILE_TRANSFORM_PROXY_URL` names a running proxy, it needs Node ≥ 22 on `PATH` (or its path in `SKAILE_TRANSFORM_PROXY_NODE`).

omp shows extension statuses on an extra line below the status line. To show the status in the status line itself, add the `status` segment and turn the extra line off in `~/.omp/agent/config.yml` (`showHookStatus: false` moves every extension status, not just this one, into the segment):

```yaml
statusLine:
  preset: custom
  leftSegments: [vim, model, status, mode, path, git, pr]
  rightSegments: [session_name, token_total, cost, context_pct]
  showHookStatus: false
```

- `/anon on` routes every provider of omp's model registry through the proxy: the provider's `baseUrl` becomes the proxy URL, and the original base URL travels in `x-skaile-transform-upstream`, next to `x-skaile-transform-session` (the omp session id) and the token. The provider's own headers and auth stay in place and are relayed.
  - With `SKAILE_TRANSFORM_PROXY_URL` (and `SKAILE_TRANSFORM_PROXY_TOKEN`) set, it uses that running proxy, and the proxy applies its `defaultPipeline`.
  - Otherwise it starts one proxy per omp process as a child process: the system Node (`SKAILE_TRANSFORM_PROXY_NODE`, else `node` from `PATH`) runs this package's CLI with the config lookup of the CLI (`./.skaile/transform-proxy.yaml`, then `~/.config/skaile/transform-proxy.yaml`), `--port 0 --host 127.0.0.1 --exit-with-stdin` and a random token in `SKAILE_TRANSFORM_PROXY_TOKEN`, which every routed provider sends. That config must set `defaultPipeline`. Without a config, `/anon on` refuses and says where to put one. A child that exits before printing `listening <url>`, or stays silent for 60 s, fails `/anon on` with its last stderr lines.
  - omp is a compiled Bun executable, and its resolver cannot load transform modules with native or ML dependencies (`onnxruntime-node`, `@huggingface/transformers`, `ibantools`) from `node_modules`; Node can. The child exits with omp: its stdin pipe closes when omp exits (SIGKILL included), and omp kills it on a normal exit. It does not keep omp's event loop alive. A child that dies later is replaced on the next turn.
  - Providers on a wire the proxy does not rewrite (Bedrock, Vertex, Gemini, agent bridges, providers without a base URL) are routed too, so the proxy refuses their requests: the setup fails closed. `/anon status` lists them as refused.
  - The session's active model is rebound to the re-routed one, so the next request already uses the new base URL. A rebind that fails is an activation failure: `/anon on` rolls the routes back, saves nothing and stays off. When anon is required, or a later turn's rebind fails while anon is on, the status shows `🟠A`.
- While anon is on or in error, a `before_provider_request` handler checks every model request: a request whose model does not target the proxy gets its payload replaced with an empty object, so no conversation text leaves, and an error notice names the model. omp has no hook that cancels a provider request, and a throwing handler is only logged, so this replacement is the block.
- While anon is on or in error, images are not sent: the extension sets omp's `images.blockImages` in omp's in-memory runtime settings layer, and omp replaces every image in the request, history included, with the note `Image reading is disabled.`. The proxy cannot anonymize images and refuses every request that carries one (400 `unsupported_content`), and omp resends the whole history each turn, so a single screenshot would otherwise block the session. `/anon off` drops the override, so your own `images.blockImages` setting applies again; the override is never written to `config.yml`. An omp without this settings API gets a warning instead, and the proxy keeps refusing images.
- The proxy session follows the root omp session: on `/new`, `/resume`, `/fork` (`session_switch`) and on a root `session_start` with a new session id, every provider is re-routed with the new `x-skaile-transform-session`. The proxy keeps the old session's state in memory until it exits; no request carries that id again. A `session_start` of a headless `print` session (how omp runs subagents) keeps the parent's id, so subagents share its pseudonyms.
- `/anon off` restores the original base URLs and headers.
- `/anon status` shows the state, the proxy URL and its source, the pipeline, the session id, the trace target (`trace: <dir>` or `trace: off`), whether images are blocked, and the routed and refused providers. The own proxy child inherits `SKAILE_TRANSFORM_PROXY_TRACE_DIR` with the rest of omp's environment, so the [trace](#trace) is on when that variable is set (shown resolved against the cwd) or when the config sets `trace.dir`. With an external proxy (`SKAILE_TRANSFORM_PROXY_URL`) only the variable is known; the status shows `trace: off` without it, whatever that proxy does.
- The extension keeps reading its proxy child's stderr after `listening <url>`. Each [leak warning](#leak-check) becomes a warning notice, once per session and kind while the child lives, so a leak in the history does not repeat every round: `anon: a known <kind> value was sent to the provider in clear text (at <path>, route <route>). Value not shown.` Leak warnings of an external proxy stay in that proxy's log.
- `/anon on` and `/anon off` switch only the omp process they run in: that window, its subagents, and the sessions it opens with `/new`, `/resume` and `/fork`. Other omp windows are not touched, and the saved default does not change.
- `/anon on --global` and `/anon off --global` also save the default for omp processes started later, in `skaile-transform-proxy.json` in omp's agent dir (`~/.omp/agent`; `SKAILE_TRANSFORM_PROXY_OMP_STATE` overrides the path). A session start applies a saved `on` until the first successful `/anon on|off` in that process; from then on the process follows its own choice. A failed `/anon on --global` saves nothing.
- `SKAILE_TRANSFORM_PROXY_MODE=required` (set by a skaile session in required mode) turns routing on at session start and refuses `/anon off`.

The overrides are registered under the model-registry source `skaile-transform-proxy`, so `/anon off` clears them in one catalog reload. A provider that another extension registered at runtime is taken over while anon is on; `/anon off` restores its base URL and headers, and a provider that existed only at runtime is reported as lost (restart omp to restore it).

## Writing a transform module

A module default-exports a `TransformModule`:

- `open(config, { baseDir, log })` runs once per proxy. It validates the config and builds shared state. Throwing rejects startup.
- It returns a `TransformFactory`, which runs once per `(session, pipeline)`: `(ctx: { sessionId, facts, log }) => Transform`.
- A `Transform` has `instruction?`, `outbound(text, leaf)`, `inbound(text)`, `inboundStream()`, `dispose?()`, `inspect?()` (host-only state, read through `proxy.inspect`; the walkers never call it) and `knownOriginals?()`.
- `knownOriginals?(): Iterable<{ kind, value }>` returns the originals the instance has already replaced in this session, each with its kind (forge-anon: its mapping). Only the [leak check](#leak-check) reads them, as source `pipeline`; the values are never sent or logged. `composeTransforms` returns the union of all stages that implement it; a stage that throws is logged and skipped.

The Anthropic walker appends the pipeline `instruction` after the host's system prompt: a string `system` gets it after a blank line, a block array gets it as one more text block at the end, and an absent `system` becomes the instruction. The host's leading blocks stay first, because Claude Code gateways (TeamClaude) refuse Sonnet requests with 429 `rate_limit_error` when the system prompt does not start with the Claude Code blocks. The OpenAI walkers still put the instruction first: a leading `system` message in chat completions, a prefix of `instructions` in responses.

Those leading blocks also pass untransformed: a system text that starts with the Claude Code identity sentence (`You are Claude Code, Anthropic's official CLI for Claude.`) keeps that sentence, and one that starts with `x-anthropic-billing-header:` keeps that first line; the rest of the text is transformed. Anthropic's Claude subscription (OAuth) check reads them verbatim and answers 429 `rate_limit_error` with the message `Error` when they differ, and a German NER reads `Claude` as a name and a `cc_version` as an IP address. The host writes these blocks; they carry no user data.

`inboundStream().push(c1) + … + flush()` must equal `inbound(c1 + … + cn)` for every chunking.

Connectors publish facts through `proxy.session(id).publisher(source)`. Facts are in-process only.

## Security notes

- The default host is `127.0.0.1`. Set a token before binding elsewhere.
- Use `allowUpstreams` to limit where requests can go.
- Clear text never leaves the proxy in a transformed field. Auth headers are relayed, not logged.
- Fields the walkers do not rewrite (`tools`, metadata, unknown fields) are forwarded as they are. The [leak check](#leak-check) warns when one of them carries a known original; it does not block the request.
- Leak warnings carry kind, source and JSON path, never the value. Trace files and any other `TraceSink` get the clear text that leaked: keep them local, never commit them, delete them once reviewed.
- Mappings, facts, the signature cache and the trace hashes are kept in memory and are lost on restart.
