# What to install — the software Agent-Nuvira uses

`npm install -g agent-nuvira` installs the agent itself. It cannot install the
**other** software the agent uses on your machine — video encoding, a browser,
local models — because those are operating-system packages, not npm packages.

This page is the complete list, in one place. Every row is real: the agent
probes for it, and if it is missing it **says which feature was skipped rather
than quietly returning nothing**.

> **In a hurry?** Run `nuvira doctor --fix`. It lists what is missing, shows the
> exact command for your OS, and installs the ones you say yes to. Nothing is
> installed without asking.

---

## 1. The baseline (required)

| Software | Why | Get it |
|---|---|---|
| **Node.js ≥ 18.18.0** | Runs the agent (`engines` in `package.json`). Node 20+ recommended | [nodejs.org](https://nodejs.org/) · macOS `brew install node` |
| **npm** | Ships with Node; used by the agent's own tooling | bundled with Node |
| **Git** | Every mode that tracks changes, worktrees, and diffs against a commit | [git-scm.com](https://git-scm.com/downloads) · macOS `brew install git` |

Optional **Node-side** extras (not OS packages — the setup scripts handle them):

| Extra | Why | Get it |
|---|---|---|
| Native **FAISS** | Much faster semantic search / memory recall | `brew install faiss libomp openblas && npm rebuild @faiss-node/native` |
| **Local embeddings** | Free, offline, private embeddings instead of a cloud call | ships as an optional npm dependency (`npm rebuild onnxruntime-node`) |

See the README's *Native FAISS acceleration* and *Local embeddings* sections for
the tiers and the fallbacks.

---

## 2. The tools the agent uses (optional, recommended)

| Tool | What it unlocks | macOS | Linux (Debian/Ubuntu) | Windows |
|---|---|---|---|---|
| **FFmpeg** | Encode the motion renderer's frames into a video; preview, trim, merge, transcode video and audio | `brew install ffmpeg-full` | `sudo apt-get update && sudo apt-get install -y ffmpeg` | `winget install Gyan.FFmpeg` |
| **Chromium (Playwright)** | The browser tools (open a page, click, extract) and the motion renderer's frame capture | `npx playwright install chromium` | `npx playwright install chromium` | `npx playwright install chromium` |
| **Ollama** | Models on your own machine: no API key, no cost, works offline | `brew install ollama` | `curl -fsSL https://ollama.com/install.sh \| sh` | `winget install Ollama.Ollama` |
| **edge-tts** | Narration for `speak` and for a motion render's voice-over — free, no account | `pip3 install --user edge-tts` | `pip3 install --user edge-tts` | `pip install edge-tts` |
| **Piper** *(optional)* | A fully offline voice when edge-tts is absent or there is no network | `pip3 install --user piper-tts` | `pip3 install --user piper-tts` | `pip install piper-tts` |
| **Whisper** *(optional)* | Transcribe audio and voice notes locally (`transcribe`) | `pip3 install --user openai-whisper` | `pip3 install --user openai-whisper` | `pip install openai-whisper` |
| **Poppler** *(optional)* | Read a scanned, image-only PDF by rasterising its pages for the vision model | `brew install poppler` | `sudo apt-get update && sudo apt-get install -y poppler-utils` | see §3 |

**Linux notes.** The commands above use `apt-get`; on Fedora/RHEL use `dnf`, on
Arch `pacman -S`, on Alpine `apk add`. `nuvira doctor` prints the command for the
package manager **your** machine actually has. The `ffmpeg` and `poppler`
installs need `sudo`, so `--fix` will not run them unattended — it prints the one
command for you to run.

**Windows notes.** `winget install …` may need a new terminal afterwards.
`winget install Gyan.FFmpeg` and `Ollama.Ollama` are the packages the setup script
uses.

**Python tools.** `edge-tts`, `piper-tts` and `openai-whisper` are Python
packages: they need Python 3 with pip (`pip3`). `pip3 install --user` puts the
executable in a user directory that is usually already on `PATH`; if the tool is
still not found, add the directory from `python3 -m site --user-base` + `/bin`.

---

## 3. The caveats that actually bite

**macOS: install `ffmpeg-full`, not `ffmpeg`.** The plain Homebrew `ffmpeg`
formula is a lean bottle built without **libass**, so a render with burned-in
captions silently falls back to a separate `.srt` file next to the video. The
render reports that it did, but the captions are not on the picture.
`ffmpeg-full` is *keg-only* — Homebrew will not put it on your `PATH`, so add it:

```bash
brew install ffmpeg-full
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"   # add to ~/.zshrc to keep it
ffmpeg -filters | grep subtitles                        # prints a line when libass is present
```

On Linux the distro `ffmpeg` package normally includes libass already.

**The chromium bundle is Playwright's, not your browser.** `npx playwright
install chromium` downloads a browser into Playwright's own cache
(`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux,
`%LOCALAPPDATA%\ms-playwright` on Windows). Your everyday Chrome is not used.
Playwright itself is an *optional* npm dependency of agent-nuvira; if `npx
playwright` is not found, run `npm install -g playwright` first. If you set
`PLAYWRIGHT_BROWSERS_PATH=0`, browsers live inside `node_modules` where the probe
cannot see them and `nuvira doctor` will report chromium as missing even though
it works — that is the check being honest about what it can see, not a bug.

**Ollama needs a model before it is useful.** Installing the server is one step;
the first model is another (several GB): `ollama serve` (or `brew services start
ollama`), then `ollama pull llama3.2`.

**Piper needs a voice file.** The package installs the engine, not a voice. Point
`NUVIRA_PIPER_MODEL` at a downloaded `.onnx` voice.

**Whisper pulls PyTorch.** It is a large download. whisper.cpp builds a much
smaller `whisper-cli` binary, and the agent accepts either; ffmpeg is needed
either way.

**Poppler on Windows** ships as a zip of binaries, not an installable package, so
there is no one-line command. Download a build, add its `bin/` to `PATH`. On
Linux the package is `poppler-utils` (not `poppler`).

---

## 4. Check what you have — and install the rest

```bash
nuvira doctor          # full health report; the runtime tools are listed with
                       # ✅/⚠️, what each one unlocks, and the exact command for
                       # YOUR operating system
nuvira doctor --fix    # offers each missing tool one at a time, installs it,
                       # then VERIFIES it is detectable (never assumes)
```

`nuvira doctor --fix` will not run an install that needs a password it cannot
supply: it prints the one command for you and stops there. Piped or CI output
never blocks — the commands are printed instead.

The same list is in the dashboard: **System → checks** shows one row per tool
(`Runtime: FFmpeg`, `Runtime: Chromium (Playwright)`, …) with the same status and
fix, because the CLI and the dashboard render the same check results.

**New machine?** The one-command setup scripts do all of this for you — Node,
Git, agent-nuvira, and then these tools, asking before each step:

| OS | Run this |
|---|---|
| macOS | `bash <(curl -fsSL https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/scripts/setup/install-macos.sh)` |
| Linux | `bash <(curl -fsSL https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/scripts/setup/install-linux.sh)` |
| Windows | `Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force; irm https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/scripts/setup/install-windows.ps1 | iex` |

Re-running them is safe: anything already installed is skipped.

---

## 5. What actually happens when one is missing

Nothing breaks, and nothing pretends. The feature that needs the tool reports
itself as **skipped**, with the reason:

| Missing | What you see |
|---|---|
| FFmpeg | The motion renderer stops before encoding and names ffmpeg; audio/video skills say the tool is unavailable |
| Chromium | `motion_render` (HTML/preset route) and the `browser_*` tools refuse with the install command; a `frames_dir` render still works, since it only encodes |
| FFmpeg without libass | The video is written, the `.srt` is written, and the render says the burn was skipped |
| edge-tts / Piper | Narration is reported as skipped — the video is produced silent, not produced with a silent failure |
| Whisper | `transcribe` says no local backend is available |
| Poppler | A scanned PDF says no rasteriser is available; a PDF with a text layer still reads fine |
| Ollama | The local provider reports the server as unreachable; cloud providers you have keys for are unaffected |

The agent is also told which of these are missing at the start of a run, so it
can install one itself when a task needs it, or tell you the single command —
instead of claiming a feature worked.

---

*This list is code, not prose: it comes from `src/learning/runtime-dependencies.ts`,
the same declarations the doctor rows, the `--fix` installer and the agent's own
prompt are built from. Adding a tool there adds it here, and
`tests/learning/runtime-dependencies.test.ts` fails if this page stops matching.*
