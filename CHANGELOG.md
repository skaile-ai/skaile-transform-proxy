# Changelog

## 0.2.0 (unreleased)

- OpenAI chat completions (`/chat/completions`) and OpenAI responses (`/responses`) walkers: text leaves, tool-call arguments and reasoning summaries are transformed outbound and restored in JSON and SSE replies; `image_url`, `input_audio`, `file`, `input_image` and `input_file` parts are refused with 400 `unsupported_content`. Responses reasoning summaries are cached by item id so a replayed reasoning item is sent back byte for byte.

## 0.1.0

- First release: transform contract, chain composition, per-session state and facts, the HTTP proxy with the Anthropic Messages walker, and the `skaile-transform-proxy` CLI.
