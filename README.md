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
skaile-transform-proxy [--config <file>] [--port <n>] [--host <h>] [--token <t>]
```

- The token comes from `--token` or `SKAILE_TRANSFORM_PROXY_TOKEN`.
- Without `--config`, the proxy reads `./.skaile/transform-proxy.yaml`, then `~/.config/skaile/transform-proxy.yaml`.
- On start it prints `listening <url>`. It stops on SIGINT or SIGTERM.

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

## omp extension

The package ships an [omp](https://omp.sh) extension (subpath `@skaile/transform-proxy/omp`, declared in the package manifest under `omp.extensions`):

```sh
omp plugin install @skaile/transform-proxy
```

It adds the command `/anon on|off|status` and the footer status `anon on` / `anon off`.

- `/anon on` routes every provider of omp's model registry through the proxy: the provider's `baseUrl` becomes the proxy URL, and the original base URL travels in `x-skaile-transform-upstream`, next to `x-skaile-transform-session` (the omp session id) and the token. The provider's own headers and auth stay in place and are relayed.
  - With `SKAILE_TRANSFORM_PROXY_URL` (and `SKAILE_TRANSFORM_PROXY_TOKEN`) set, it uses that running proxy, and the proxy applies its `defaultPipeline`.
  - Otherwise it starts one proxy inside the omp process, from the config lookup of the CLI (`./.skaile/transform-proxy.yaml`, then `~/.config/skaile/transform-proxy.yaml`). That config must set `defaultPipeline`. Without a config, `/anon on` refuses and says where to put one.
  - Providers on a wire the proxy does not rewrite (Bedrock, Vertex, Gemini, agent bridges, providers without a base URL) are routed too, so the proxy refuses their requests: the setup fails closed. `/anon status` lists them as refused.
  - The session's active model is rebound to the re-routed one, so the next request already uses the new base URL.
- `/anon off` restores the original base URLs and headers.
- `/anon status` shows the state, the proxy URL and its source, the pipeline, the session id, and the routed and refused providers.
- The enabled flag is saved in `skaile-transform-proxy.json` in omp's agent dir (`~/.omp/agent`; `SKAILE_TRANSFORM_PROXY_OMP_STATE` overrides the path) and re-applied when a session starts.
- `SKAILE_TRANSFORM_PROXY_MODE=required` (set by a skaile session in required mode) turns routing on at session start and refuses `/anon off`.

The overrides are registered under the model-registry source `skaile-transform-proxy`, so `/anon off` clears them in one catalog reload. A provider that another extension registered at runtime is taken over while anon is on; `/anon off` restores its base URL and headers, and a provider that existed only at runtime is reported as lost (restart omp to restore it).

## Writing a transform module

A module default-exports a `TransformModule`:

- `open(config, { baseDir, log })` runs once per proxy. It validates the config and builds shared state. Throwing rejects startup.
- It returns a `TransformFactory`, which runs once per `(session, pipeline)`: `(ctx: { sessionId, facts, log }) => Transform`.
- A `Transform` has `instruction?`, `outbound(text, leaf)`, `inbound(text)`, `inboundStream()` and `dispose?()`.

The Anthropic walker appends the pipeline `instruction` after the host's system prompt: a string `system` gets it after a blank line, a block array gets it as one more text block at the end, and an absent `system` becomes the instruction. The host's leading blocks stay first, because Claude Code gateways (TeamClaude) refuse Sonnet requests with 429 `rate_limit_error` when the system prompt does not start with the Claude Code blocks. The OpenAI walkers still put the instruction first: a leading `system` message in chat completions, a prefix of `instructions` in responses.

`inboundStream().push(c1) + … + flush()` must equal `inbound(c1 + … + cn)` for every chunking.

Connectors publish facts through `proxy.session(id).publisher(source)`. Facts are in-process only.

## Security notes

- The default host is `127.0.0.1`. Set a token before binding elsewhere.
- Use `allowUpstreams` to limit where requests can go.
- Clear text never leaves the proxy in a transformed field. Auth headers are relayed, not logged.
- Mappings, facts and the signature cache are kept in memory and are lost on restart.
