import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { nanoid } from 'nanoid';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || '';
const MAX_CONCURRENT = Math.max(1, Math.min(4, Number(process.env.MAX_CONCURRENT || 2)));
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"] } } }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_LIMIT || 40), standardHeaders: 'draft-7', legacyHeaders: false }));

const jobs = new Map();
const queue = [];
let active = 0;
const readHistory = () => { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; } };
const writeHistory = items => fs.writeFileSync(HISTORY_FILE, JSON.stringify(items.slice(0, 100), null, 2));

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const supplied = req.get('x-api-key') || req.query.key || '';
  if (supplied !== API_KEY) return res.status(401).json({ error: 'API key required' });
  next();
}
app.use('/api', requireKey);

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:') || x.startsWith('::ffff:127.');
  }
  return true;
}
async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('সঠিক ভিডিও URL দিন।'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('শুধু HTTP/HTTPS URL গ্রহণযোগ্য।');
  if (u.username || u.password) throw new Error('URL-এর মধ্যে username/password দেওয়া যাবে না।');
  if (u.hostname === 'localhost' || u.hostname.endsWith('.local')) throw new Error('Local/private host অনুমোদিত নয়।');
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) throw new Error('এই ডোমেইন ALLOWED_HOSTS-এ নেই।');
  const records = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!records.length || records.some(r => isPrivateAddress(r.address))) throw new Error('Private বা resolve না হওয়া host অনুমোদিত নয়।');
  return u.toString();
}
function runYtDlp(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.YTDLP_PATH || 'yt-dlp', args, { cwd: __dirname, windowsHide: true });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(new Error('yt-dlp চালু করা যায়নি। Setup guide দেখুন।')); } });
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error((stderr || 'yt-dlp failed').slice(-1200))); });
  });
}
function safeTitle(s) { return String(s || 'video').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100); }
function chooseFormat(info, quality, audioOnly) {
  if (audioOnly) return 'bestaudio/best';
  const height = Number(quality) || 0;
  if (height === 0) return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best';
  return `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'NoyonX Video Downloader', ytDlp: process.env.YTDLP_PATH || 'yt-dlp', active, queued: queue.length }));

app.post('/api/analyze', async (req, res) => {
  try {
    const url = await validateUrl(String(req.body?.url || ''));
    const raw = await runYtDlp(['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist', '--', url]);
    const info = JSON.parse(raw.trim().split('\n').at(-1));
    const formats = (info.formats || []).filter(f => f.url && (f.vcodec !== 'none' || f.acodec !== 'none')).map(f => ({
      formatId: String(f.format_id), ext: f.ext || 'unknown', height: f.height || null,
      width: f.width || null, fps: f.fps || null, filesize: f.filesize || f.filesize_approx || null,
      hasVideo: f.vcodec !== 'none', hasAudio: f.acodec !== 'none', note: f.format_note || ''
    })).slice(0, 100);
    res.json({ id: info.id, title: info.title || 'Untitled video', thumbnail: info.thumbnail || null,
      duration: info.duration || null, uploader: info.uploader || null, webpageUrl: info.webpage_url || url,
      formats, extractor: info.extractor_key || info.extractor || 'Direct URL' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!job || job.status === 'cancelled') continue;
    active++;
    job.status = 'downloading'; job.updatedAt = Date.now();
    const args = ['--newline', '--no-playlist', '--no-warnings', '--continue', '--part', '--concurrent-fragments', '4', '--progress', '--progress-template', 'download:NYX %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s', '-f', job.format, '-o', path.join(DOWNLOAD_DIR, `${job.id}-%(title).100B.%(ext)s`)];
    if (job.audioOnly) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    args.push('--', job.url);
    const child = spawn(process.env.YTDLP_PATH || 'yt-dlp', args, { cwd: __dirname, windowsHide: true });
    job.child = child;
    let stderr = '';
    child.stdout.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.startsWith('NYX ')) continue;
        const p = line.slice(4).split(' ');
        job.downloaded = Number(p[0]) || 0; job.total = Number(p[1]) || 0;
        const match = (p[2] || '').match(/[0-9.]+/);
        job.percent = match ? Math.min(100, Number(match[0])) : job.percent;
        job.speed = p[3] || ''; job.eta = p[4] || ''; job.updatedAt = Date.now();
      }
    });
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', () => finishJob(job, false, 'yt-dlp চালু করা যায়নি।'));
    child.on('close', code => {
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(job.id + '-'));
      if (code === 0 && files.length) { job.file = files.find(f => !f.endsWith('.part')) || files[0]; job.percent = 100; finishJob(job, true); }
      else finishJob(job, false, stderr.slice(-800) || 'Download failed');
    });
  }
}
function finishJob(job, ok, error) {
  if (job.finished) return;
  job.finished = true; job.child = null; active = Math.max(0, active - 1);
  job.status = ok ? 'completed' : (job.status === 'cancelled' ? 'cancelled' : 'error');
  if (error) job.error = error;
  job.updatedAt = Date.now();
  const history = readHistory();
  history.unshift({ id: job.id, title: job.title, status: job.status, file: job.file || null, createdAt: job.createdAt, completedAt: job.updatedAt });
  writeHistory(history);
  pump();
}
app.post('/api/download', async (req, res) => {
  try {
    const url = await validateUrl(String(req.body?.url || ''));
    const audioOnly = req.body?.audioOnly === true;
    const quality = String(req.body?.quality || 'best');
    if (!audioOnly && quality !== 'best' && !['144','240','360','480','720','1080','1440','2160'].includes(quality)) return res.status(400).json({ error: 'Invalid quality' });
    const id = nanoid(12);
    const job = { id, url, title: safeTitle(req.body?.title || 'Video'), format: audioOnly ? 'bestaudio/best' : chooseFormat({}, quality, false), audioOnly, quality, status: 'queued', percent: 0, downloaded: 0, total: 0, speed: '', eta: '', createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job); queue.push(job); pump();
    res.status(202).json({ id, status: job.status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'Job not found (server may have restarted)' });
  res.json({ id: j.id, title: j.title, status: j.status, percent: j.percent, downloaded: j.downloaded, total: j.total, speed: j.speed, eta: j.eta, file: j.file || null, error: j.error || null });
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'Job not found' });
  if (j.status === 'queued') { const i = queue.indexOf(j); if (i >= 0) queue.splice(i, 1); j.status = 'cancelled'; j.finished = true; }
  else if (j.child) { j.status = 'cancelled'; j.child.kill('SIGTERM'); }
  res.json({ ok: true, status: j.status });
});
app.post('/api/jobs/:id/retry', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  if (!['error', 'cancelled'].includes(j.status)) return res.status(409).json({ error: 'Only failed/cancelled jobs can be resumed' });
  j.status = 'queued'; j.percent = 0; j.error = null; j.finished = false; j.updatedAt = Date.now();
  queue.push(j); pump();
  res.json({ ok: true, id: j.id, status: j.status, resume: true });
});
app.get('/api/jobs/:id/file', (req, res) => {
  const j = jobs.get(req.params.id); if (!j || j.status !== 'completed' || !j.file) return res.status(404).json({ error: 'File not ready' });
  const full = path.join(DOWNLOAD_DIR, path.basename(j.file));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  res.download(full, j.file.replace(/^.+?-/, ''), err => { if (err) console.error('Download response error:', err.message); });
});
app.get('/api/history', (req, res) => res.json(readHistory()));
app.delete('/api/history', (req, res) => { writeHistory([]); res.json({ ok: true }); });
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, HOST, () => console.log(`NoyonX is running at http://${HOST}:${PORT}`));
