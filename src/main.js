import { extractAudioChunks } from './audio-extract.js';

const $ = (id) => document.getElementById(id);
const fileInput = $('file'), drop = $('drop'), fileLabel = $('fileLabel');
const goBtn = $('go'), langSel = $('lang'), out = $('out');
const statusEl = $('status'), barWrap = $('barWrap'), bar = $('bar');
const copyBtn = $('copy'), dlBtn = $('download');

let current = null;

function setFile(f) {
  current = f || null;
  fileLabel.textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : 'Click or drop a file here';
  goBtn.disabled = !f;
}
function setStatus(msg) { statusEl.textContent = msg; }
function setBar(frac) { barWrap.hidden = frac == null; if (frac != null) bar.style.width = `${Math.round(frac * 100)}%`; }

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

async function transcribeChunk(chunk, lang) {
  const q = new URLSearchParams({ name: chunk.name });
  if (lang) q.set('lang', lang);
  const res = await fetch(`/api/transcribe?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: chunk,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data.text || '';
}

goBtn.addEventListener('click', async () => {
  if (!current) return;
  goBtn.disabled = true; copyBtn.disabled = true; dlBtn.disabled = true;
  out.value = '';
  try {
    // 1) video -> small audio chunks (automatic)
    const chunks = await extractAudioChunks(current, (p, stage) => {
      setStatus(`${stage}… ${Math.round(p * 100)}%`);
      setBar(p);
    });

    // 2) send each chunk for transcription
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      setStatus(`Transcribing part ${i + 1} of ${chunks.length}…`);
      setBar(i / chunks.length);
      parts.push((await transcribeChunk(chunks[i], langSel.value)).trim());
      out.value = parts.join('\n\n');
    }
    setBar(1);
    setStatus('Done.');
    copyBtn.disabled = dlBtn.disabled = !out.value;
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
    setBar(null);
  } finally {
    goBtn.disabled = !current;
  }
});

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(out.value);
  setStatus('Copied.');
});
dlBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([out.value], { type: 'text/plain' }));
  a.download = (current?.name.replace(/\.[^.]+$/, '') || 'transcript') + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});
