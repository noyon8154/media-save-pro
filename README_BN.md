# NoyonX Video Downloader

Self-hosted web application for analyzing and downloading media that you own or are authorized to save. It uses the open-source **yt-dlp** project for supported extractor metadata and downloads, and **FFmpeg** (through yt-dlp's post-processing) for audio extraction/merging.

## Included
- Responsive dark NoyonX web UI
- URL analysis: title, thumbnail, duration, extractor and available formats
- Best available / up-to quality selector (144p–4K when available)
- MP4-preferred video download and MP3 audio extraction
- Download queue, concurrency limit, live progress, speed and ETA
- Cancel jobs; yt-dlp `--continue` and `.part` files support resuming interrupted transfers when the same job is restarted by the downloader
- Recent download history
- API key option, rate limiting, URL validation and private-network address blocking

## Requirements
- Node.js 20+
- Python 3.10+ (for yt-dlp installation; current yt-dlp releases may require Python 3.10+)
- yt-dlp (install from the official GitHub repository)
- FFmpeg + ffprobe (required for merging separate video/audio streams and MP3 conversion)

Official projects:
- yt-dlp: https://github.com/yt-dlp/yt-dlp
- FFmpeg: https://github.com/FFmpeg/FFmpeg

This project does **not** bundle third-party binaries. Install them from official sources and follow their licenses. yt-dlp and FFmpeg are tools, not a hosted universal download API; the NoyonX server invokes the local yt-dlp executable.

## Termux (Android)
```bash
pkg update -y && pkg upgrade -y
pkg install nodejs-lts python ffmpeg -y
python -m pip install -U yt-dlp
cd noyonx-video-downloader
npm install
cp .env.example .env
# For Termux, use HOST=0.0.0.0 in .env if you need LAN access; localhost works on the same phone.
npm start
```
Open `http://127.0.0.1:3000` in the phone browser.

If Termux does not provide `nodejs-lts`, use `pkg install nodejs`.

## Windows
1. Install Node.js LTS, Python 3 and FFmpeg; ensure `node`, `python`, `yt-dlp`, `ffmpeg` and `ffprobe` are on PATH.
2. In PowerShell, open this folder and run:
```powershell
py -m pip install -U yt-dlp
npm install
Copy-Item .env.example .env
npm start
```
3. Open `http://127.0.0.1:3000`.

## Configuration
Copy `.env.example` to `.env` and set values. This app does not load `.env` automatically; either export variables in your shell or start with a dotenv loader. Easiest cross-platform option:
```bash
npm install dotenv
```
Then add `import 'dotenv/config';` as the first line of `server.js`.

For public hosting:
- Set a long random `API_KEY` and keep it secret.
- Set `HOST=127.0.0.1` behind a reverse proxy where possible.
- Set `ALLOWED_HOSTS` to domains you explicitly trust.
- Add HTTPS, authentication, storage quotas, job expiry, monitoring and a firewall.
- Do not run this as an unrestricted public proxy/downloader. Shared public deployments need abuse controls and legal review.

## API
All endpoints are under `/api`. If `API_KEY` is set, send `x-api-key: YOUR_KEY`.

- `GET /api/health` — service status
- `POST /api/analyze` JSON `{ "url": "https://..." }` — metadata and formats
- `POST /api/download` JSON `{ "url": "https://...", "title": "...", "quality": "1080", "audioOnly": false }` — create job
- `GET /api/jobs/:id` — progress/status
- `POST /api/jobs/:id/cancel` — cancel
- `GET /api/jobs/:id/file` — download completed file
- `GET /api/history` — recent history
- `DELETE /api/history` — clear history

## Notes / limitations
- Quality choices are capped by formats actually provided by the source. A 4K option does not create 4K from a lower-resolution source.
- Separate video/audio merging and MP3 conversion require FFmpeg.
- Some sites may be unsupported, region-restricted or require permissions. DRM, paywalls, private content and access controls are not bypassed. Do not use browser cookies or credentials to access content without authorization.
- Job state is in memory; a server restart clears active job status. Completed files and history are stored locally. A production version should use Redis/SQLite/PostgreSQL and durable job workers.
- Browser download progress after clicking Save is controlled by the browser. Server-side progress is shown in the job panel.
- For very large files, configure disk space, reverse-proxy timeouts and download retention.

## License
NoyonX starter application source: MIT (see LICENSE). yt-dlp, FFmpeg and their dependencies are separate projects with their own licenses and must be installed separately.

### Resume / concurrent fragments
Failed or cancelled jobs can be resumed from the same job panel; the server reuses the same output template and yt-dlp's partial `.part` file with `--continue`. Fragmented HLS/DASH sources can use up to four concurrent fragments (`--concurrent-fragments 4`). A source that does not support byte ranges/fragments may not support resume or parallel transfer.
