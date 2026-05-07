# Cloud TTS for VSCode

Right-click selected text (in an **editor** or in the **integrated terminal**) → "Read Aloud" → audio plays via `afplay` on macOS.

Supports **Gemini**, **OpenAI**, and **ElevenLabs** as TTS backends — pick whichever you like the sound of best.

## Why

Native macOS `say` voices are robotic. Cloud providers sound human:
- **Gemini 2.5** — natural prosody, supports natural-language style prompts ("Say sarcastically:")
- **OpenAI gpt-4o-mini-tts** — fast, cheap, supports `instructions`
- **ElevenLabs** — top-tier voice cloning quality

## Install

```bash
cd ~/Documents/vsc-extensions/cloud-tts
npx --yes @vscode/vsce package --allow-missing-repository
code           --install-extension cloud-tts-*.vsix   # stable VSCode
code-insiders  --install-extension cloud-tts-*.vsix   # Insiders (if you use it)
```

Re-run after edits to update. Reload windows with `Cmd+Shift+P → Developer: Reload Window`.

## First-time setup

1. **Set an API key**: `Cmd+Shift+P → Cloud TTS: Set API Key…` → pick provider → paste key. The input field is masked, and the key is stored in VSCode's encrypted **SecretStorage** — never written to `settings.json`, never synced.
2. **Pick a provider** (if not Gemini): `Cmd+Shift+P → Cloud TTS: Switch Provider`, or set `cloudTts.provider` in Settings.
3. **(Optional) tune voice/model**: `Cmd+Shift+P → Cloud TTS: Open Settings`.

| Provider | Get a key at |
|---|---|
| Gemini | https://aistudio.google.com/apikey |
| OpenAI | https://platform.openai.com/api-keys |
| ElevenLabs | https://elevenlabs.io/app/settings/api-keys |

## Usage

| Action | How |
|---|---|
| Read selection (editor) | Right-click → *Read Aloud* &nbsp;·&nbsp; `Cmd+K Cmd+R` |
| Read selection (terminal) | Right-click → *Read Aloud* &nbsp;·&nbsp; `Cmd+K Cmd+R` |
| Stop playback | `Cmd+K Cmd+S` &nbsp;·&nbsp; `Cloud TTS: Stop Playback` |
| Quick switch provider | `Cloud TTS: Switch Provider` |
| Set / change API key | `Cloud TTS: Set API Key…` (masked input) |
| Delete all stored keys | `Cloud TTS: Clear All API Keys` |
| Open settings | `Cloud TTS: Open Settings` |
| Cancel during synthesis | Cancel button on the progress notification |

> **Terminal selection** is read via a brief clipboard round-trip (the only way without an official API). The clipboard is restored to its previous content immediately after.

## Settings reference

### Top-level
| Setting | Default | Notes |
|---|---|---|
| `cloudTts.provider` | `gemini` | Active provider |

API keys are **not** in Settings — use `Cloud TTS: Set API Key…` instead (encrypted).

### Gemini
| Setting | Default | Notes |
|---|---|---|
| `cloudTts.gemini.model` | `gemini-2.5-flash-preview-tts` | Or `gemini-2.5-pro-preview-tts` for better prosody |
| `cloudTts.gemini.voice` | `Kore` | 30 voices: Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, … |
| `cloudTts.gemini.stylePrompt` | _(empty)_ | Prepended to text. e.g. `"Say in a calm, neutral tone:"` |

### OpenAI
| Setting | Default | Notes |
|---|---|---|
| `cloudTts.openai.model` | `gpt-4o-mini-tts` | Or `tts-1`, `tts-1-hd` |
| `cloudTts.openai.voice` | `nova` | `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse` |
| `cloudTts.openai.instructions` | _(empty)_ | gpt-4o-mini-tts only. e.g. `"Speak cheerfully."` |

> `ash` / `ballad` / `coral` / `sage` / `verse` only work with `gpt-4o-mini-tts`.

### ElevenLabs
| Setting | Default | Notes |
|---|---|---|
| `cloudTts.elevenlabs.model` | `eleven_multilingual_v2` | Or `eleven_turbo_v2_5`, `eleven_flash_v2_5` |
| `cloudTts.elevenlabs.voiceId` | `21m00Tcm4TlvDq8ikWAM` (Rachel) | Browse https://elevenlabs.io/app/voice-library for IDs |

## Limitations

- macOS only (uses `afplay`).
- No streaming — waits for full clip before playback. Long selections take a few seconds before audio starts.
- Terminal selection requires a clipboard round-trip (clipboard is restored after).
