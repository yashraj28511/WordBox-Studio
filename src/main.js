
import { extractAudioChunks } from './audio-extract.js';

const $ = (id) => document.getElementById(id);

const fileInput = $('file');
const drop = $('drop');
const fileLabel = $('fileLabel');
const goBtn = $('go');
const langSel = $('lang');
const out = $('out');
const statusEl = $('status');
const barWrap = $('barWrap');
const bar = $('bar');
const copyBtn = $('copy');
const dlBtn = $('download');

let current = null;

function setFile(file) {
  current = file || null;

  fileLabel.textContent = file
    ? `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`
    : 'Click or drop a file here';

  goBtn.disabled = !file;
  copyBtn.disabled = true;
  dlBtn.disabled = true;
  out.value = '';
  setStatus(file ? 'Ready to transcribe.' : 'No file selected.');
  setBar(null);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setBar(fraction) {
  barWrap.hidden = fraction == null;

  if (fraction != null) {
    const value = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    bar.style.width = `${value}%`;
  }
}

fileInput.addEventListener('change', () => {
  setFile(fileInput.files?.[0]);
});

['dragenter', 'dragover'].forEach((eventName) => {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.remove('over');
  });
});

drop.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];

  if (file) {
    setFile(file);
  }
});

async function transcribeChunk(chunk, lang) {
  if (!(chunk instanceof Blob)) {
    throw new Error('Audio extraction returned invalid data.');
  }

  if (chunk.size === 0) {
    throw new Error('An extracted audio chunk is empty.');
  }

  const filename =
    typeof chunk.name === 'string' && chunk.name.trim()
      ? chunk.name.split(/[\\/]/).pop()
      : 'audio.wav';

  const params = new URLSearchParams({ name: filename });

  if (lang) {
    params.set('lang', lang);
  }

  const response = await fetch(`/api/transcribe?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream'
    },
    body: chunk
  });

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.error ||
      data?.message ||
      responseText ||
      `Server error ${response.status}`;

    throw new Error(
      typeof message === 'string' ? message : JSON.stringify(message)
    );
  }

  if (!data || typeof data.text !== 'string') {
    throw new Error('The transcription server returned an unexpected response.');
  }

  return data.text;
}

goBtn.addEventListener('click', async () => {
  if (!current) return;

  const selectedFile = current;

  goBtn.disabled = true;
  copyBtn.disabled = true;
  dlBtn.disabled = true;
  out.value = '';

  try {
    setStatus('Extracting audio…');
    setBar(0);

    const chunks = await extractAudioChunks(selectedFile, (progress, stage) => {
      setStatus(`${stage}… ${Math.round(progress * 100)}%`);
      setBar(progress);
    });

    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new Error('No audio chunks were extracted from this file.');
    }

    const parts = [];

    for (let index = 0; index < chunks.length; index++) {
      if (current !== selectedFile) {
        throw new Error('The selected file changed. Please try again.');
      }

      setStatus(`Transcribing part ${index + 1} of ${chunks.length}…`);
      setBar(index / chunks.length);

      const text = await transcribeChunk(chunks[index], langSel.value);
      parts.push(text.trim());

      out.value = parts.filter(Boolean).join('\n\n');
      setBar((index + 1) / chunks.length);
    }

    setStatus('Done.');
    copyBtn.disabled = !out.value.trim();
    dlBtn.disabled = !out.value.trim();
  } catch (error) {
    console.error('Transcription failed:', error);

    setStatus(`Error: ${error.message || 'Unknown error'}`);
    setBar(null);
  } finally {
    goBtn.disabled = !current;
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(out.value);
    setStatus('Copied to clipboard.');
  } catch (error) {
    console.error('Copy failed:', error);
    setStatus('Could not copy. Please copy the transcript manually.');
  }
});

dlBtn.addEventListener('click', () => {
  const baseName = current?.name
    ? current.name.replace(/\.[^.]+$/, '')
    : 'transcript';

  const blob = new Blob([out.value], {
    type: 'text/plain;charset=utf-8'
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `${baseName}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
