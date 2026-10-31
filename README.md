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
| `GET …/models` | Passthrough. |
| anything else (chat completions, responses, embeddings) | 404 `unsupported_route`. |

OpenAI chat and responses walkers are not implemented yet. Embeddings are refused on purpose: a vector of pseudonymized input cannot be restored.

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

## Writing a transform module

A module default-exports a `TransformModule`:

- `open(config, { baseDir, log })` runs once per proxy. It validates the config and builds shared state. Throwing rejects startup.
- It returns a `TransformFactory`, which runs once per `(session, pipeline)`: `(ctx: { sessionId, facts, log }) => Transform`.
- A `Transform` has `instruction?`, `outbound(text, leaf)`, `inbound(text)`, `inboundStream()` and `dispose?()`.

`inboundStream().push(c1) + … + flush()` must equal `inbound(c1 + … + cn)` for every chunking.

Connectors publish facts through `proxy.session(id).publisher(source)`. Facts are in-process only.

## Security notes

- The default host is `127.0.0.1`. Set a token before binding elsewhere.
- Use `allowUpstreams` to limit where requests can go.
- Clear text never leaves the proxy in a transformed field. Auth headers are relayed, not logged.
- Mappings, facts and the signature cache are kept in memory and are lost on restart.
