const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ─── Audio format constants ──────────────────────────────────────────────────
// Gemini returns headerless PCM at exactly this format. We synthesize a WAV
// header before playback. If Google ever changes the return format, audio
// will play at the wrong speed/pitch — pin these to what the API guarantees.
const GEMINI_PCM_SAMPLE_RATE = 24000;
const GEMINI_PCM_CHANNELS = 1;
const GEMINI_PCM_BITS_PER_SAMPLE = 16;

// SecretStorage key prefix. Final keys: cloudTts.apiKey.gemini etc.
const SECRET_KEY_PREFIX = 'cloudTts.apiKey.';

const PROVIDERS = [
    { value: 'gemini',     label: 'Gemini',     placeholder: 'AIza…',      url: 'https://aistudio.google.com/apikey' },
    { value: 'openai',     label: 'OpenAI',     placeholder: 'sk-…',       url: 'https://platform.openai.com/api-keys' },
    { value: 'elevenlabs', label: 'ElevenLabs', placeholder: 'sk_…',       url: 'https://elevenlabs.io/app/settings/api-keys' },
];

// ─── State ───────────────────────────────────────────────────────────────────
// Track the active afplay child so a second invocation cancels the first
// instead of overlapping audio.
let currentPlayer = null;

// ─── VSCode lifecycle ────────────────────────────────────────────────────────
function activate(context) {
    const secrets = context.secrets;
    context.subscriptions.push(
        // Default-provider entry point — used by the keybinding and palette.
        vscode.commands.registerCommand('cloudTts.readSelection', () => readSelection(secrets)),
        // Per-provider entry points — bound to the right-click submenu so the
        // user can pick a provider ad-hoc without changing the saved default.
        vscode.commands.registerCommand('cloudTts.readSelection.gemini', () => readSelection(secrets, 'gemini')),
        vscode.commands.registerCommand('cloudTts.readSelection.openai', () => readSelection(secrets, 'openai')),
        vscode.commands.registerCommand('cloudTts.readSelection.elevenlabs', () => readSelection(secrets, 'elevenlabs')),
        vscode.commands.registerCommand('cloudTts.stop', stopPlayback),
        vscode.commands.registerCommand('cloudTts.openSettings', openSettings),
        vscode.commands.registerCommand('cloudTts.switchProvider', switchProvider),
        vscode.commands.registerCommand('cloudTts.setApiKey', () => setApiKey(secrets)),
        vscode.commands.registerCommand('cloudTts.clearApiKeys', () => clearApiKeys(secrets)),
    );
}

function deactivate() {
    stopPlayback();
}

// ─── Commands ────────────────────────────────────────────────────────────────
function openSettings() {
    // Filter by publisher.name; this matches whatever ID VS Code knows the
    // extension as, which is the Marketplace publisher (geryit) once installed
    // from there, but stays "local.cloud-tts" if installed from a local VSIX.
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:geryit.cloud-tts');
}

async function switchProvider() {
    const cfg = vscode.workspace.getConfiguration('cloudTts');
    const current = cfg.get('provider', 'gemini');
    const pick = await vscode.window.showQuickPick(
        PROVIDERS.map((p) => ({
            label: p.label,
            value: p.value,
            description: p.value === current ? '(active)' : '',
        })),
        { placeHolder: `Active provider: ${current}` },
    );
    if (pick) {
        await cfg.update('provider', pick.value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Cloud TTS: switched to ${pick.label}.`);
    }
}

// Provider picker that renders a link-icon button on each row. Clicking the
// button opens the provider's API-key page in the user's browser without
// dismissing the picker, so they can still pick a row to proceed afterwards.
async function pickProviderWithLink({ placeholder, buttonTooltip }) {
    return new Promise((resolve) => {
        const qp = vscode.window.createQuickPick();
        const linkButton = {
            iconPath: new vscode.ThemeIcon('link-external'),
            tooltip: buttonTooltip,
        };
        qp.items = PROVIDERS.map((p) => ({
            label: p.label,
            detail: p.url,
            value: p.value,
            buttons: [linkButton],
        }));
        qp.placeholder = placeholder;
        qp.ignoreFocusOut = true;
        qp.onDidTriggerItemButton((event) => {
            const url = event.item.detail;
            if (url) vscode.env.openExternal(vscode.Uri.parse(url));
        });
        qp.onDidAccept(() => {
            resolve(qp.selectedItems[0]);
            qp.hide();
        });
        qp.onDidHide(() => {
            // Hide fires both on accept (after we already resolved) and on
            // dismiss; the duplicate resolve is harmless because Promise
            // resolution is idempotent.
            resolve(undefined);
            qp.dispose();
        });
        qp.show();
    });
}

async function setApiKey(secrets, prefilledProvider) {
    let providerEntry;
    if (prefilledProvider) {
        providerEntry = PROVIDERS.find((p) => p.value === prefilledProvider);
    }
    if (!providerEntry) {
        // Use createQuickPick (not showQuickPick) so we can attach per-item
        // buttons. The simple form's `detail` field renders the URL but is
        // plain text — buttons are the only way to make the link actionable.
        const pick = await pickProviderWithLink({
            placeholder: 'Which provider’s key are you setting?',
            buttonTooltip: 'Open API key page in browser',
        });
        if (!pick) return;
        providerEntry = PROVIDERS.find((p) => p.value === pick.value);
    }

    // password: true is the masked-input flag — characters render as dots.
    const key = await vscode.window.showInputBox({
        prompt: `${providerEntry.label} API key`,
        placeHolder: providerEntry.placeholder,
        password: true,
        ignoreFocusOut: true,
    });
    if (!key || !key.trim()) return;

    await secrets.store(`${SECRET_KEY_PREFIX}${providerEntry.value}`, key.trim());
    vscode.window.showInformationMessage(`Cloud TTS: ${providerEntry.label} API key saved.`);
}

async function clearApiKeys(secrets) {
    const confirm = await vscode.window.showWarningMessage(
        'Delete all stored Cloud TTS API keys (Gemini, OpenAI, ElevenLabs)?',
        { modal: true },
        'Delete',
    );
    if (confirm !== 'Delete') return;
    await Promise.all(
        PROVIDERS.map((p) => secrets.delete(`${SECRET_KEY_PREFIX}${p.value}`)),
    );
    vscode.window.showInformationMessage('Cloud TTS: all API keys cleared.');
}

async function readSelection(secrets, providerOverride) {
    const text = await getActiveSelectionText();
    if (!text || !text.trim()) {
        vscode.window.showInformationMessage('Cloud TTS: no text selected.');
        return;
    }

    const cfg = vscode.workspace.getConfiguration('cloudTts');
    // Submenu picks pass an override; everything else uses the saved default.
    const provider = providerOverride || cfg.get('provider', 'gemini');

    const apiKey = await getApiKey(secrets, provider);
    if (!apiKey) {
        // Use the friendly label ("Gemini" not "gemini") and tell the user
        // exactly where to grab a key, so the first-run experience doesn't
        // feel like a dead-end.
        const providerEntry = PROVIDERS.find((p) => p.value === provider);
        const label = providerEntry?.label || provider;
        const choice = await vscode.window.showWarningMessage(
            `Cloud TTS: No ${label} API key set. Get one from ${label}, then paste it here to start reading text aloud.`,
            { modal: false },
            'Set Key',
            'Get Key',
        );
        if (choice === 'Set Key') {
            await setApiKey(secrets, provider);
        } else if (choice === 'Get Key' && providerEntry?.url) {
            // Open the provider's key page AND immediately surface the input
            // box, so when the user comes back from the browser with a key
            // copied, it's already waiting for them.
            await vscode.env.openExternal(vscode.Uri.parse(providerEntry.url));
            await setApiKey(secrets, provider);
        }
        return;
    }

    // Cancel any in-flight playback so back-to-back invocations don't overlap.
    stopPlayback();

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Cloud TTS (${provider})…`,
            cancellable: true,
        },
        async (_progress, token) => {
            try {
                const audioFile = await synthesizeToFile({ provider, cfg, apiKey, text, token });
                if (token.isCancellationRequested || !audioFile) return;
                play(audioFile);
            } catch (err) {
                if (err.name === 'AbortError') return;
                vscode.window.showErrorMessage(`Cloud TTS: ${err.message}`);
            }
        },
    );
}

// ─── Selection sources ───────────────────────────────────────────────────────
// Editor selection takes precedence; otherwise we fall back to terminal
// selection via the clipboard-roundtrip trick (no public API exposes terminal
// selection text directly).
async function getActiveSelectionText() {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
        return editor.document.getText(editor.selection);
    }
    if (vscode.window.activeTerminal) {
        return readTerminalSelection();
    }
    return undefined;
}

// Round-trip via the clipboard: save → clear → run terminal.copySelection
// → read what landed → restore the original. The clear-first step lets us
// detect "no selection" (clipboard stays empty) without false positives if
// the user already had identical text on their clipboard.
async function readTerminalSelection() {
    const original = await vscode.env.clipboard.readText();
    try {
        await vscode.env.clipboard.writeText('');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
        // Tiny defensive delay so the clipboard write has settled before read.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const copied = await vscode.env.clipboard.readText();
        return copied;
    } finally {
        // Always restore — never trash the user's clipboard.
        await vscode.env.clipboard.writeText(original);
    }
}

// ─── API key resolution ──────────────────────────────────────────────────────
// SecretStorage is the only source of truth. Returns undefined if missing.
async function getApiKey(secrets, provider) {
    const stored = await secrets.get(`${SECRET_KEY_PREFIX}${provider}`);
    return stored && stored.trim() ? stored.trim() : undefined;
}

// ─── Provider dispatch ───────────────────────────────────────────────────────
async function synthesizeToFile({ provider, cfg, apiKey, text, token }) {
    if (provider === 'gemini') return synthesizeGemini({ cfg, apiKey, text, token });
    if (provider === 'openai') return synthesizeOpenAI({ cfg, apiKey, text, token });
    if (provider === 'elevenlabs') return synthesizeElevenLabs({ cfg, apiKey, text, token });
    throw new Error(`Unknown provider: ${provider}`);
}

// ─── Gemini ──────────────────────────────────────────────────────────────────
// Returns raw PCM in inlineData.data; we wrap it in a WAV header on disk.
async function synthesizeGemini({ cfg, apiKey, text, token }) {
    const model = cfg.get('gemini.model', 'gemini-2.5-flash-preview-tts');
    const voice = cfg.get('gemini.voice', 'Kore');
    const stylePrompt = (cfg.get('gemini.stylePrompt', '') || '').trim();

    const prompt = stylePrompt ? `${stylePrompt} ${text}` : text;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
        },
    };

    const res = await abortableFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
    }, token);

    const json = await res.json();
    const b64 = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) {
        throw new Error('Gemini returned no audio (check that the model supports TTS).');
    }
    const pcm = Buffer.from(b64, 'base64');
    return writeWavTempFile(pcm);
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────
// Returns mp3 directly; afplay handles mp3 natively.
async function synthesizeOpenAI({ cfg, apiKey, text, token }) {
    const model = cfg.get('openai.model', 'gpt-4o-mini-tts');
    const voice = cfg.get('openai.voice', 'nova');
    const instructions = (cfg.get('openai.instructions', '') || '').trim();

    const body = {
        model,
        voice,
        input: text,
        response_format: 'mp3',
    };
    // The `instructions` field is only meaningful on gpt-4o-mini-tts; sending
    // it on tts-1/tts-1-hd is silently ignored, but skip it anyway to stay clean.
    if (instructions && model === 'gpt-4o-mini-tts') {
        body.instructions = instructions;
    }

    const res = await abortableFetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    }, token);

    const buf = Buffer.from(await res.arrayBuffer());
    return writeBinaryTempFile(buf, 'mp3');
}

// ─── ElevenLabs ──────────────────────────────────────────────────────────────
// Returns mp3 by default.
async function synthesizeElevenLabs({ cfg, apiKey, text, token }) {
    const model = cfg.get('elevenlabs.model', 'eleven_multilingual_v2');
    const voiceId = cfg.get('elevenlabs.voiceId', '21m00Tcm4TlvDq8ikWAM');

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
    const body = { text, model_id: model };

    const res = await abortableFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
            'xi-api-key': apiKey,
        },
        body: JSON.stringify(body),
    }, token);

    const buf = Buffer.from(await res.arrayBuffer());
    return writeBinaryTempFile(buf, 'mp3');
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
// Wraps fetch() so VSCode's progress-cancel button aborts the request, and
// surfaces non-2xx responses as Errors with the body included for debugging.
async function abortableFetch(url, init, token) {
    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`HTTP ${res.status} — ${errText.slice(0, 400)}`);
        }
        return res;
    } finally {
        cancelSub.dispose();
    }
}

// ─── File / playback helpers ─────────────────────────────────────────────────
// Build a 44-byte canonical PCM WAV header in front of the raw samples.
function writeWavTempFile(pcm) {
    const byteRate = GEMINI_PCM_SAMPLE_RATE * GEMINI_PCM_CHANNELS * GEMINI_PCM_BITS_PER_SAMPLE / 8;
    const blockAlign = GEMINI_PCM_CHANNELS * GEMINI_PCM_BITS_PER_SAMPLE / 8;
    const dataSize = pcm.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                  // fmt chunk size
    header.writeUInt16LE(1, 20);                   // PCM format
    header.writeUInt16LE(GEMINI_PCM_CHANNELS, 22);
    header.writeUInt32LE(GEMINI_PCM_SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(GEMINI_PCM_BITS_PER_SAMPLE, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return writeBinaryTempFile(Buffer.concat([header, pcm]), 'wav');
}

function writeBinaryTempFile(buf, ext) {
    const filePath = path.join(os.tmpdir(), `cloud-tts-${Date.now()}-${process.pid}.${ext}`);
    fs.writeFileSync(filePath, buf);
    return filePath;
}

function play(filePath) {
    currentPlayer = spawn('afplay', [filePath], { stdio: 'ignore' });
    currentPlayer.on('close', () => {
        currentPlayer = null;
        // Best-effort cleanup; if VSCode crashed mid-playback the OS will
        // sweep /tmp eventually anyway.
        fs.unlink(filePath, () => {});
    });
}

function stopPlayback() {
    if (currentPlayer) {
        currentPlayer.kill('SIGTERM');
        currentPlayer = null;
    }
}

module.exports = { activate, deactivate };
