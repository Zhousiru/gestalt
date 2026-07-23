![Banner](./assets/banner.webp)

# Gestalt

Interactive chatbot system.

## Features

- Context-aware group replies, DMs, reactions, pokes, images, stickers, and silence.
- Browser automation through phase-scoped just-bash and agent-browser.
- Markdown-based long-term memory maintained through dreaming.
- Background sticker collection, vision analysis, embedding search, and model-selected sending.

## Docker

Create `gestalt-home/config.toml` from the example below, set `MODEL_API_KEY`
and `ONEBOT_ACCESS_TOKEN` in your environment, then run:

```sh
docker run --rm --name gestalt \
  -p 3000:3000 \
  -e MODEL_API_KEY \
  -e ONEBOT_ACCESS_TOKEN \
  -v "$PWD/gestalt-home:/var/lib/gestalt" \
  ghcr.io/zhousiru/gestalt
```

The mounted directory stores all runtime data and must be writable. The live UI is available at `http://localhost:3000` when enabled.

## Configuration

Gestalt reads strict, flat TOML from `GestaltHome/config.toml`. See the [configuration reference](docs/CONFIGURATION.md) for every available setting.

Example:

```toml
allowedgroups = ["123456789"]

connector = "onebot-forward-ws"
onebot_ws_url = "ws://onebot:3001"
onebot_access_token_env = "ONEBOT_ACCESS_TOKEN"

live_enabled = true
live_host = "0.0.0.0"
live_port = 3000

main_model_provider = "openai-compatible"
main_model_base_url = "https://your-model-provider.example/v1"
main_model_name = "your-model"
main_model_api_key_env = "MODEL_API_KEY"

# Optional vision model for sticker understanding. Other fields inherit above.
sub_model_name = "your-vision-model"

embedding_model_provider = "openai-compatible"
embedding_model_base_url = "https://your-model-provider.example/v1"
embedding_model_name = "your-embedding-model"
embedding_model_id = "your-embedding-model:1024"
embedding_model_api_key_env = "MODEL_API_KEY"
embedding_model_dimensions = 1024

sticker_scraping_enabled = true
sticker_recommendation_probability = 0.25

dreaming_enabled = true
```

## Persona

Put one or more persona files in `gestalt-home/persona/`. A single `persona.md` is enough. See [writing a persona](docs/PERSONA.md) for the format and a short example.

> [!NOTE]
> Currently tested only on QQ through OneBot v11.
