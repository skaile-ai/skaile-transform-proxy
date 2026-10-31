# Changelog

## 0.2.0

- OpenAI chat completions (`/chat/completions`) and OpenAI responses (`/responses`) walkers: text leaves, tool-call arguments and reasoning summaries are transformed outbound and restored in JSON and SSE replies; `image_url`, `input_audio`, `file`, `input_image` and `input_file` parts are refused with 400 `unsupported_content`. Responses reasoning summaries are cached by item id so a replayed reasoning item is sent back byte for byte.
- omp extension (`@skaile/transform-proxy/omp`, manifest `omp.extensions`): `/anon on|off|status` routes every provider of omp's model registry through the proxy (an external one from `SKAILE_TRANSFORM_PROXY_URL`, or one started in-process from the CLI config lookup), shows `anon on` / `anon off` in the footer, persists the flag in omp's agent dir and refuses `off` under `SKAILE_TRANSFORM_PROXY_MODE=required`.

## 0.1.0

- First release: transform contract, chain composition, per-session state and facts, the HTTP proxy with the Anthropic Messages walker, and the `skaile-transform-proxy` CLI.
