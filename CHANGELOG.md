# Changelog

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
