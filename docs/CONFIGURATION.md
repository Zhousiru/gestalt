# Configuration Reference

Gestalt reads `config.toml` from GestaltHome. The file uses flat TOML keys: nested tables, unknown keys, invalid types, and out-of-range values fail at startup. Secrets should be stored in environment variables and referenced by name.

## Connector and host

| Key | Description | Default |
| --- | --- | --- |
| `connector` | `mock`, `onebot-forward-ws`, or `onebot-reverse-ws`. | `mock` |
| `allowedgroups` | Optional array of group IDs. Events from other groups are ignored. | All groups |
| `onebot_ws_url` | OneBot WebSocket URL; required in forward mode. | — |
| `onebot_host` | Bind address for reverse mode. | `0.0.0.0` |
| `onebot_port` | Bind port; required in reverse mode. | — |
| `onebot_path` | WebSocket path for reverse mode. | `/onebot/v11/ws` |
| `onebot_access_token_env` | Environment variable containing the OneBot token. | — |
| `live_enabled` | Enable the live trace UI and API. | `false` |
| `live_host` | Live server bind address. Use `0.0.0.0` in Docker. | `127.0.0.1` |
| `live_port` | Live server port. | `3000` |

## Language models

`main_model_*` configures chat, inspect, and dreaming. `main_model_base_url` and `main_model_name` are required when the model is used. `sub_model_*` configures auxiliary work such as sticker understanding; every omitted sub-model field inherits its resolved main-model value.

Both prefixes support these suffixes:

| Suffix | Description | Main-model default |
| --- | --- | --- |
| `provider` | Provider adapter name. | `openai-compatible` |
| `base_url` | OpenAI-compatible API base URL. | Required |
| `name` | Provider model ID. | Required |
| `api_key_env` | Environment variable containing the API key. | `MODEL_API_KEY` |
| `api_key` | Direct API key. Mutually exclusive with `api_key_env`; environment variables are preferred. | — |
| `temperature` | Non-negative sampling temperature. | `1` |
| `max_steps` | Maximum tool-loop steps. | `1000` |
| `routing_order` | Comma-separated provider routing preference; an empty string clears inherited sub-model routing. | — |
| `routing_allow_fallbacks` | Allow providers outside `routing_order`. | Provider default |
| `routing_sort` | `price`, `throughput`, `latency`, or an empty string. | Provider default |
| `thinking` | Provider-specific thinking mode; an empty string disables the override. | Provider default |
| `tool_choice` | `required`, `auto`, `none`, or an empty string. | Provider default |
| `prompt_cache_enabled` | Enable provider prompt caching. | Provider-dependent |
| `prompt_cache_ttl` | `5m`, `1h`, or an empty string. | Provider default |

## Embedding model

The embedding role is independent and does not inherit language-model settings.

| Key | Description | Default |
| --- | --- | --- |
| `embedding_model_provider` | Provider adapter name. | `openai-compatible` |
| `embedding_model_base_url` | Embedding API base URL. | Required when configured |
| `embedding_model_name` | Provider model ID. | Required when configured |
| `embedding_model_id` | Stable identity for vector-space compatibility. Change it when the model or dimensions change. | Required when configured |
| `embedding_model_api_key_env` | Environment variable containing the API key. | `EMBEDDING_MODEL_API_KEY` |
| `embedding_model_api_key` | Direct API key; mutually exclusive with `embedding_model_api_key_env`. | — |
| `embedding_model_dimensions` | Expected positive vector length. Responses with another length are rejected. | Unchecked |
| `embedding_model_routing_order` | Comma-separated provider routing preference. | — |
| `embedding_model_routing_allow_fallbacks` | Allow providers outside the routing order. | Provider default |

## Stickers

| Key | Description | Default |
| --- | --- | --- |
| `sticker_scraping_enabled` | Collect observed stickers for later retrieval. | `false` |
| `sticker_processing_concurrency` | Parallel sticker-analysis jobs (`1`–`32`). | `1` |
| `sticker_recommendation_probability` | Chance of attaching sticker candidates after a text send (`0`–`1`). | `0` |
| `sticker_recommendation_limit` | Maximum candidates per recommendation (`1`–`20`). | `3` |
| `operator_user_ids` | Users allowed to change sticker scraping with runtime commands. | `[]` |

## Identity, context, and persistence

| Key | Description | Default |
| --- | --- | --- |
| `timezone` | IANA timezone used in model context. | System timezone, then UTC |
| `bot_user_id` | Bot ID stored for self-authored session messages. | Connector account ID, then `gestalt-bot` |
| `bot_display_name` | Bot name stored for self-authored session messages. | `Gestalt` |
| `session_recent_history_hours` | Journal history restored at startup. | `24` |
| `context_recent_message_count` | Previous messages added to a new model session (`0`–`500`). | `0` |
| `trace_binary_capture_enabled` | Persist binary trace blobs. Privacy-sensitive. | `false` |
| `dreaming_enabled` | Run terminal narrative-memory maintenance. | `false` |

## Triggers

Probabilities use deterministic sampling in the inclusive range `0`–`1`.

| Key | Description | Default |
| --- | --- | --- |
| `trigger_enabled` | Master switch for automatic group triggers. | `true` |
| `trigger_mention_enabled` | Enable direct-mention triggers. | `true` |
| `trigger_mention_probability` | Admission probability for mention triggers. | `1` |
| `trigger_keyword_names` | Comma-separated names matched case-insensitively. | Empty |
| `trigger_keyword_regex` | Case-insensitive JavaScript regular expression. | Empty |
| `trigger_keyword_probability` | Admission probability for keyword triggers. | `1` |
| `trigger_activity_enabled` | Trigger after sufficient recent group activity. | `true` |
| `trigger_activity_probability` | Admission probability for activity triggers. | `1` |
| `trigger_activity_window_ms` | Activity counting window in milliseconds. | `600000` |
| `trigger_activity_min_messages` | Prior-message threshold within the activity window. | `5` |
| `trigger_icebreaker_enabled` | Trigger after a quiet period. | `true` |
| `trigger_icebreaker_probability` | Admission probability for icebreaker triggers. | `1` |
| `trigger_icebreaker_quiet_ms` | Required quiet period in milliseconds. | `3600000` |

## Agent loop

| Key | Description | Default |
| --- | --- | --- |
| `agent_loop_aggregation_delay_ms` | Initial delay for gathering nearby messages. | `10000` |
| `agent_loop_aggregation_max_delay_ms` | Maximum aggregation delay; must not be lower than the initial delay. | Initial delay |
| `agent_loop_aggregation_backoff_multiplier` | Delay multiplier after additional messages; minimum `1`. | `1` |
| `agent_loop_exit_say_nothing_enabled` | Exit after repeated `say_nothing` actions. | `true` |
| `agent_loop_exit_say_nothing_count` | Consecutive `say_nothing` actions required to exit. | `3` |
| `agent_loop_exit_idle_enabled` | Exit an inactive loop after a timeout. | `true` |
| `agent_loop_exit_idle_ms` | Idle timeout in milliseconds. | `180000` |
