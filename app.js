const $ = id => document.getElementById(id);
let analyzed = null, currentJob = null, poller = null;

const api = async (path, options = {}) => {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...($('apikey')?.value ? { 'x-api-key': $('apikey').value } : {}), ...(options.headers || {}) },
    ...options
  });
  const data = await r.json().catch(() => ({ error: 'Unexpected server response' }));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
};

function duration(s) {
  if (!s) return '';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = String(Math.floor(s % 3600 / 60)).padStart(2, '0'), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${m}:${sec}` : `${Math.floor(s / 60)}:${sec}`;
}
function bytes(n) {
  if (!n) return 'Size unknown';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}
function status(t, kind = '') {
  const el = $('status');
  el.textContent = t;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function setLoading(btn, on) { btn.classList.toggle('loading', on); btn.disabled = on; }

/* ---------- URL box helpers ---------- */
function syncClear() { $('clearurl').classList.toggle('hidden', !$('url').value); }
$('url').addEventListener('input', syncClear);
$('url').addEventListener('keydown', e => { if (e.key === 'Enter') $('analyze').click(); });
$('clearurl').onclick = () => { $('url').value = ''; syncClear(); $('url').focus(); };
$('paste').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { $('url').value = t.trim(); syncClear(); }
  } catch (e) { status('Clipboard access blocked. Please paste the link manually (Ctrl+V).', 'err'); $('url').focus(); }
};

/* ---------- format / quality selectors ---------- */
function setFormat(v) {
  $('format').value = v;
  document.querySelectorAll('#fmtseg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('qwrap').classList.toggle('hidden', v === 'audio');
}
document.querySelectorAll('#fmtseg button').forEach(b => b.onclick = () => setFormat(b.dataset.v));

function buildQualityChips() {
  const box = $('qchips'); box.replaceChildren();
  [...$('quality').options].forEach(opt => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'q'; b.dataset.v = opt.value; b.disabled = opt.disabled;
    b.textContent = opt.value === 'best' ? 'Best' : opt.value === '2160' ? '4K' : opt.value === '1440' ? '2K' : `${opt.value}p`;
    b.onclick = () => selectQuality(opt.value);
    box.append(b);
  });
  selectQuality('best');
}
function selectQuality(v) {
  $('quality').value = v;
  document.querySelectorAll('#qchips .q').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}

/* ---------- analyze ---------- */
$('analyze').onclick = async () => {
  const url = $('url').value.trim();
  if (!url) { status('আগে একটি ভিডিও URL দিন।', 'err'); return; }
  setLoading($('analyze'), true); $('video').classList.add('hidden'); status('Analyzing video…', 'busy');
  try {
    analyzed = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ url }) });
    $('title').textContent = analyzed.title;
    const meta = $('meta'); meta.replaceChildren();
    [[analyzed.extractor, ''], [`${analyzed.formats.length} formats`, 'c']].forEach(([t, c]) => {
      if (!t) return; const s = document.createElement('span'); s.className = 'tag2 ' + c; s.textContent = t; meta.append(s);
    });
    $('dur').textContent = duration(analyzed.duration); $('dur').classList.toggle('hidden', !analyzed.duration);
    $('video').classList.toggle('nothumb', !analyzed.thumbnail);
    if (analyzed.thumbnail) { $('thumb').src = analyzed.thumbnail; $('thumb').parentElement.classList.remove('hidden'); }
    else $('thumb').parentElement.classList.add('hidden');
    const heights = [...new Set(analyzed.formats.filter(f => f.hasVideo && f.height).map(f => f.height))].sort((a, b) => b - a);
    const select = $('quality');
    for (const opt of [...select.options]) { if (opt.value === 'best') continue; const h = Number(opt.value); opt.disabled = !heights.some(x => x >= h); }
    buildQualityChips(); setFormat('video');
    $('video').classList.remove('hidden');
    status('Video analyzed. Choose a quality and start downloading.', 'ok');
  } catch (e) { status(`Error: ${e.message}`, 'err'); }
  finally { setLoading($('analyze'), false); }
};

/* ---------- download ---------- */
$('download').onclick = async () => {
  if (!analyzed) return; setLoading($('download'), true);
  try {
    const job = await api('/api/download', { method: 'POST', body: JSON.stringify({ url: analyzed.webpageUrl, title: analyzed.title, quality: $('quality').value, audioOnly: $('format').value === 'audio' }) });
    currentJob = job.id; $('job').classList.remove('hidden'); $('jobtitle').textContent = analyzed.title; $('joberror').textContent = '';
    $('save').classList.add('hidden'); $('retry').classList.add('hidden'); $('cancel').classList.remove('hidden');
    if (poller) clearInterval(poller); await pollJob(); poller = setInterval(pollJob, 1200);
    $('job').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { status(`Error: ${e.message}`, 'err'); }
  finally { setLoading($('download'), false); }
};

function stopPoll() { clearInterval(poller); poller = null; }
async function pollJob() {
  if (!currentJob) return;
  try {
    const j = await api(`/api/jobs/${currentJob}`);
    const p = Math.max(0, Math.min(100, j.percent || 0));
    $('percent').textContent = `${Math.round(p)}%`; $('bar').style.width = `${p}%`; $('ring').style.setProperty('--p', p);
    const st = $('jobstate'); st.textContent = j.status; st.className = 'state ' + j.status;
    $('speed').textContent = j.speed || (j.total ? `${bytes(j.downloaded)} / ${bytes(j.total)}` : '');
    $('eta').textContent = j.eta ? `ETA ${j.eta}` : '';
    if (j.status === 'completed') {
      $('save').href = `/api/jobs/${currentJob}/file`; $('save').classList.remove('hidden'); $('cancel').classList.add('hidden');
      stopPoll(); loadHistory(); status('Download complete! Tap “Save file”.', 'ok');
    }
    if (['error', 'cancelled'].includes(j.status)) {
      $('joberror').textContent = j.error || j.status; $('retry').classList.remove('hidden'); $('cancel').classList.add('hidden');
      stopPoll(); loadHistory();
    }
  } catch (e) { $('joberror').textContent = e.message; stopPoll(); }
}
$('retry').onclick = async () => {
  if (!currentJob) return;
  try {
    $('retry').classList.add('hidden'); $('cancel').classList.remove('hidden'); $('joberror').textContent = '';
    await api(`/api/jobs/${currentJob}/retry`, { method: 'POST' });
    if (poller) clearInterval(poller); await pollJob(); poller = setInterval(pollJob, 1200);
  } catch (e) { $('joberror').textContent = e.message; }
};
$('cancel').onclick = async () => {
  if (!currentJob) return;
  try { await api(`/api/jobs/${currentJob}/cancel`, { method: 'POST' }); await pollJob(); }
  catch (e) { $('joberror').textContent = e.message; }
};

/* ---------- history ---------- */
const ICONS = {
  completed: '<path d="M5 13l4 4L19 7"/>',
  error: '<path d="M6 6l12 12M18 6L6 18"/>',
  cancelled: '<path d="M6 6l12 12M18 6L6 18"/>',
  other: '<path d="M12 3v12m0 0l-5-5m5 5l5-5M4 20h16"/>'
};
async function loadHistory() {
  try {
    const rows = await api('/api/history'); const box = $('history'); box.replaceChildren();
    if (!rows.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'No download history yet.'; box.append(d); return; }
    rows.slice(0, 10).forEach(r => {
      const div = document.createElement('div'); div.className = 'hist';
      const ic = document.createElement('div'); ic.className = 'hi ' + r.status;
      ic.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[r.status] || ICONS.other}</svg>`;
      const t = document.createElement('div'); t.className = 'ht'; t.textContent = r.title || 'Video';
      const s = document.createElement('span'); s.className = 'state ' + r.status; s.textContent = r.status;
      div.append(ic, t, s); box.append(div);
    });
  } catch (e) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = e.message; $('history').replaceChildren(d); }
}
$('clear').onclick = async () => { try { await api('/api/history', { method: 'DELETE' }); loadHistory(); } catch (e) { status(e.message, 'err'); } };

buildQualityChips();
loadHistory();
