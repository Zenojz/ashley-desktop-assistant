# Jarvis / Ashley

Jarvis is a macOS desktop voice assistant. Ashley, its transparent Three.js
avatar, floats above the desktop and supports voice interaction, assembly and
fracture effects, rotation, gestures, weather lookup, and experimental music
control.

The repository ships with an optimized, openly licensed sci-fi helmet and
programmatically generated sound effects. It does not include API credentials,
personal wake-word models, voice-training samples, or local recordings.

## Requirements

- macOS 13 Ventura or newer (Apple silicon is the primary tested target)
- Node.js 22 or newer
- pnpm 9 or newer
- Xcode Command Line Tools, for the native location helper
- Optional: `ffmpeg`, only when regenerating the bundled sound effects

## API credentials

Copy `.env.example` to `.env`, then fill in only the providers you intend to
use. Never commit `.env`.

- `OPENAI_API_KEY`: OpenAI Realtime voice. Create a key using the
  [OpenAI developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request).
- `DOUBAO_APP_ID`, `DOUBAO_API_KEY`, `DOUBAO_RESOURCE_ID`: optional Doubao
  voice provider. Create an application and enable the required service in the
  [Doubao Voice documentation](https://www.volcengine.com/docs/6561/196768).
- `QWEATHER_API_HOST`, `QWEATHER_API_KEY`: optional weather lookup. Create a
  project and credential using the
  [QWeather project and credential guide](https://dev.qweather.com/en/docs/configuration/project-and-key/).
- `JARVIS_DEFAULT_CITY`: city used when a weather request does not name one.

## Install and run

```bash
cp .env.example .env
pnpm install
pnpm dev
```

On the first launch, macOS may request microphone, accessibility, Apple Events,
and location permissions. Grant only the permissions needed by the features you
use.

To build without launching Electron:

```bash
pnpm build
```

To create an unpacked macOS application:

```bash
pnpm package:mac
```

`scripts/sign-macos.sh` uses ad-hoc signing by default. Set
`JARVIS_CODESIGN_IDENTITY` to your own certificate name for a distributable
signed build.

## Ashley wake word

Open the tray menu and choose **录入 Ashley 唤醒声纹…** to record the local
wake profile. The profile is stored outside the repository by Electron and is
not uploaded as a project asset. Saying “Ashley” (including the supported
Chinese transliterations) shows the avatar; legacy Jarvis aliases remain for
compatibility.

## Generated sound effects

All bundled effects are synthesized locally from mathematical waveforms. No
downloaded audio samples are used. To regenerate them:

```bash
pnpm generate:sounds
```

This creates `wake.wav`, the approximately 2.6-second `assembly.wav`, and ten
approximately 2-second low-frequency thinking prompts under `assets/sounds/`.

## Rebuilding the helmet asset

The distributed `assets/helmet/model.glb` is already optimized to about 40,000
triangles. If you have a legally obtained source GLB, the repository keeps the
same glTF-Transform pipeline used for the release asset:

```bash
pnpm build:helmet:opensource -- source.glb assets/helmet/model.glb 40000
```

The source model contains no textures, so the pipeline and renderer use
programmatic PBR materials: black brushed gunmetal, layered cyber-pink and
cyber-cyan details, and a smooth cyan emissive eye treatment.

## Experimental music control

Music control is experimental. Some actions depend on application-window
coordinates rather than a stable public API. Updates to Kugou Music or NetEase
Cloud Music can move controls and temporarily break these actions.

## Credits

- Model: [Sci-Fi Helmet - High Poly - Ngchipv](https://sketchfab.com/3d-models/sci-fi-helmet-high-poly-ngchipv-2f7218f88b94455cb69411e4069dc3b9)
- Author: [HiepVu](https://sketchfab.com/ngchipv)
- License: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- Source: [Sketchfab](https://sketchfab.com/)

Changes for Jarvis: geometry reduced from 240,984 to approximately 40,000
triangles; texture-free source materials replaced with programmatic PBR
materials and cyan emissive eye shading.

## License

Project source code is released under the [MIT License](LICENSE). The helmet
model remains available under CC BY 4.0 with the attribution above.
