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
```

Keys are exactly the option fields. An unknown top-level key is an error. Module specifiers resolve against the config file's directory.

## CLI

```sh
skaile-transform-proxy [--config <file>] [--port <n>] [--host <h>] [--token <t>] [--exit-with-stdin]
```

- The token comes from `--token` or `SKAILE_TRANSFORM_PROXY_TOKEN`.
- Without `--config`, the proxy reads `./.skaile/transform-proxy.yaml`, then `~/.config/skaile/transform-proxy.yaml`.
- On start it prints `listening <url>`. It stops on SIGINT or SIGTERM.
- `--exit-with-stdin` also stops it when its stdin closes. A parent process that spawns the proxy with a stdin pipe and never writes to it takes the proxy down when it exits, even on SIGKILL.

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
- `/anon status` shows the state, the proxy URL and its source, the pipeline, the session id, whether images are blocked, and the routed and refused providers.
- `/anon on` and `/anon off` switch only the omp process they run in: that window, its subagents, and the sessions it opens with `/new`, `/resume` and `/fork`. Other omp windows are not touched, and the saved default does not change.
- `/anon on --global` and `/anon off --global` also save the default for omp processes started later, in `skaile-transform-proxy.json` in omp's agent dir (`~/.omp/agent`; `SKAILE_TRANSFORM_PROXY_OMP_STATE` overrides the path). A session start applies a saved `on` until the first successful `/anon on|off` in that process; from then on the process follows its own choice. A failed `/anon on --global` saves nothing.
- `SKAILE_TRANSFORM_PROXY_MODE=required` (set by a skaile session in required mode) turns routing on at session start and refuses `/anon off`.

The overrides are registered under the model-registry source `skaile-transform-proxy`, so `/anon off` clears them in one catalog reload. A provider that another extension registered at runtime is taken over while anon is on; `/anon off` restores its base URL and headers, and a provider that existed only at runtime is reported as lost (restart omp to restore it).

## Writing a transform module

A module default-exports a `TransformModule`:

- `open(config, { baseDir, log })` runs once per proxy. It validates the config and builds shared state. Throwing rejects startup.
- It returns a `TransformFactory`, which runs once per `(session, pipeline)`: `(ctx: { sessionId, facts, log }) => Transform`.
- A `Transform` has `instruction?`, `outbound(text, leaf)`, `inbound(text)`, `inboundStream()`, `dispose?()` and `inspect?()` (host-only state, read through `proxy.inspect`; the walkers never call it).

The Anthropic walker appends the pipeline `instruction` after the host's system prompt: a string `system` gets it after a blank line, a block array gets it as one more text block at the end, and an absent `system` becomes the instruction. The host's leading blocks stay first, because Claude Code gateways (TeamClaude) refuse Sonnet requests with 429 `rate_limit_error` when the system prompt does not start with the Claude Code blocks. The OpenAI walkers still put the instruction first: a leading `system` message in chat completions, a prefix of `instructions` in responses.

Those leading blocks also pass untransformed: a system text that starts with the Claude Code identity sentence (`You are Claude Code, Anthropic's official CLI for Claude.`) keeps that sentence, and one that starts with `x-anthropic-billing-header:` keeps that first line; the rest of the text is transformed. Anthropic's Claude subscription (OAuth) check reads them verbatim and answers 429 `rate_limit_error` with the message `Error` when they differ, and a German NER reads `Claude` as a name and a `cc_version` as an IP address. The host writes these blocks; they carry no user data.

`inboundStream().push(c1) + … + flush()` must equal `inbound(c1 + … + cn)` for every chunking.

Connectors publish facts through `proxy.session(id).publisher(source)`. Facts are in-process only.

## Security notes

- The default host is `127.0.0.1`. Set a token before binding elsewhere.
- Use `allowUpstreams` to limit where requests can go.
- Clear text never leaves the proxy in a transformed field. Auth headers are relayed, not logged.
- Mappings, facts and the signature cache are kept in memory and are lost on restart.
