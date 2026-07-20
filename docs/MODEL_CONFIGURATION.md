# Runtime Model Configuration

Gestalt resolves runtime models by role. The three roles share the same flat
TOML file, but they do not share the same inheritance rules.

## Language-model roles

`main_model_*` configures the main agent, terminal dreaming, and inspect.
`main_model_name` and `main_model_base_url` are required. The provider defaults
to `openai-compatible`, the API-key environment variable defaults to
`MODEL_API_KEY`, temperature defaults to `1`, and max steps defaults to `1000`.

```toml
main_model_provider = "openrouter"
main_model_base_url = "https://openrouter.ai/api/v1"
main_model_name = "deepseek/deepseek-v4-pro"
main_model_api_key_env = "OPENROUTER_API_KEY"
main_model_temperature = 1
main_model_max_steps = 1000
```

`sub_model_*` is intended for bounded auxiliary language-model work such as
sticker image understanding. Every omitted `sub_model_*` field inherits the
resolved corresponding `main_model_*` field. A deployment can therefore set
only `sub_model_name`, or omit the entire role to use the main model.
If neither the sub role nor its inherited main role specifies temperature, the
resolved default is `1`.

Inheritance is based on key presence, not truthiness. For optional string
settings, an explicitly empty value clears the inherited value. For example,
when the sub model differs from the main model and should use OpenRouter's
automatic provider selection instead of inheriting the main provider order:

```toml
sub_model_name = "qwen/qwen3.5-9b"
sub_model_routing_order = ""
```

The resolved sub request then omits `provider.order`. Other omitted sub fields
continue to inherit normally.

```toml
sub_model_name = "a-vision-capable-model"
sub_model_temperature = 1
```

Both roles support these suffixes:

```text
provider
base_url
name
api_key
api_key_env
temperature
max_steps
routing_order
routing_allow_fallbacks
routing_sort
thinking
tool_choice
prompt_cache_enabled
prompt_cache_ttl
```

For each language-model role, set at most one of `*_model_api_key` (a direct
value in `config.toml`) or `*_model_api_key_env` (an environment-variable name).
If neither is set for the main role, it defaults to `MODEL_API_KEY`. A sub role
with neither key inherits the main role's complete credential source; setting
either sub key overrides that source. Direct values make `config.toml`
secret-bearing, so prefer the environment form when the GestaltHome may be
shared.

The public pure resolvers are `resolveMainModelConfig`,
`resolveSubModelConfig`, and `resolveLanguageModelConfig`. They validate config
without reading environment variables. `createLanguageModelFromConfig` and
`createAiSdkModelFromConfig` create provider clients; both default to the main
role and accept `role: "sub"` when an auxiliary caller needs it.

## Embedding role

`embedding_model_*` is independent and never inherits language-model config.
It requires `embedding_model_id`, `embedding_model_name`, and
`embedding_model_base_url`. Its provider defaults to `openai-compatible`, and
its API-key environment variable defaults to `EMBEDDING_MODEL_API_KEY`.

Supported keys are:

```text
embedding_model_provider
embedding_model_base_url
embedding_model_name
embedding_model_id
embedding_model_api_key
embedding_model_api_key_env
embedding_model_dimensions
embedding_model_routing_order
embedding_model_routing_allow_fallbacks
```

For example, a self-hosted OpenAI-compatible embedding endpoint can be
configured independently from the language-model roles:

```toml
embedding_model_provider = "openai-compatible"
embedding_model_base_url = "http://embedding-service:3000/v1"
embedding_model_name = "harrier-0.6b-int8"
embedding_model_id = "harrier-0.6b-int8:1024:reaction-v1"
embedding_model_api_key_env = "EMBEDDING_MODEL_API_KEY"
embedding_model_dimensions = 1024
```

Set exactly one of `embedding_model_api_key` (a direct value in `config.toml`)
or `embedding_model_api_key_env` (the name of an environment variable). If both
are present, configuration fails. If neither is present, the environment name
defaults to `EMBEDDING_MODEL_API_KEY`. Prefer the environment form when the
GestaltHome or harness artifacts may be shared; a direct key makes
`config.toml` itself secret-bearing.

`embedding_model_dimensions` is optional. When present, it must be a positive
integer and the embedding client rejects responses with a different vector
length.

`embedding_model_id` is a non-secret, operator-defined identity for vector-space
compatibility. Keep it unchanged when only the provider, proxy, base URL, or API
key changes but the returned vector space remains compatible. Change it when
the model, dimensions, or provider behavior changes the vector space. The
sticker index uses this id to select its LanceDB table and decide whether stored
descriptions require re-embedding.

For routing services that accept OpenRouter-compatible provider selection,
`embedding_model_routing_order` is a comma-separated provider slug preference
and `embedding_model_routing_allow_fallbacks` controls whether providers outside
that list may be used. Direct model endpoints should omit both settings. Routing
changes transport only; they do not change `embedding_model_id` when the vector
space stays compatible.

Use `resolveEmbeddingModelConfig` for pure validation and
`createEmbeddingClientFromConfig` for runtime calls. The returned client exposes
provider/model metadata and an `embed(text, options?)` boundary, keeping vector
consumers independent from the AI SDK provider implementation. Document inputs
are sent unchanged. Query inputs use `inputType: "query"` and are sent as
`Instruct: Retrieve text matching the user's intended reaction\nQuery: <text>`
so asymmetric retrieval models receive their expected query instruction.

## Configuration boundaries

GestaltHome runtime configuration accepts only `main_model_*` and
`sub_model_*` language-model keys. The `model_*` keys in
`harness/config/eval.toml` are a separate schema for the external eval judge;
they are not a Gestalt runtime model role.

## File parsing and validation

GestaltHome `config.toml` is parsed as TOML and validated against one strict Zod
schema before runtime components consume it. The runtime rejects malformed
TOML, nested tables, unknown keys, invalid value types, out-of-range values, and
inconsistent aggregation delay bounds. This is intentional: a misspelled key
must fail startup instead of silently falling back to a default.

Run the durable config verification with:

```text
pnpm --filter @gestalt/harness run verify:config
```
