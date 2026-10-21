// Turns a (possibly huge) video/audio file into small mono AAC chunks, in the browser.
// Each chunk is ~8 minutes (~3 MB), which fits Vercel's 4.5 MB request limit
// and OpenAI's 25 MB limit comfortably.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
const SEGMENT_SECONDS = 480;
const PASS_THROUGH_MAX = 3.5 * 1024 * 1024; // small audio files are sent as-is

let ffmpegPromise = null;
function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ffmpeg;
    })().catch((e) => { ffmpegPromise = null; throw e; });
  }
  return ffmpegPromise;
}

function isAudio(file) {
  if (file.type) return file.type.startsWith('audio/');
  return /\.(mp3|m4a|wav|aac|ogg|flac|opus)$/i.test(file.name);
}

/**
 * @param {File} file
 * @param {(fraction:number, stage:string)=>void} onProgress
 * @returns {Promise<File[]>} one or more small audio files, in order
 */
export async function extractAudioChunks(file, onProgress = () => {}) {
  if (isAudio(file) && file.size <= PASS_THROUGH_MAX) return [file];

  onProgress(0, 'Loading converter');
  const ffmpeg = await getFFmpeg();

  const onProg = ({ progress }) => {
    if (Number.isFinite(progress)) onProgress(Math.min(Math.max(progress, 0), 1), 'Extracting audio');
  };
  ffmpeg.on('progress', onProg);

  const dir = '/input';
  let mounted = false;
  const written = [];

  try {
    await ffmpeg.createDir(dir);
    await ffmpeg.mount('WORKERFS', { files: [file] }, dir); // no full load into RAM
    mounted = true;

    const code = await ffmpeg.exec([
      '-i', `${dir}/${file.name}`,
      '-vn', '-map', '0:a:0',
      '-ac', '1', '-ar', '16000',
      '-c:a', 'aac', '-b:a', '48k',
      '-f', 'segment', '-segment_format', 'mp4',
      '-segment_time', String(SEGMENT_SECONDS),
      '-reset_timestamps', '1',
      'chunk_%03d.m4a',
    ]);
    if (code !== 0) throw new Error('Could not extract audio (no audio track, or unsupported format).');

    const names = (await ffmpeg.listDir('/'))
      .filter((e) => !e.isDir && /^chunk_\d+\.m4a$/.test(e.name))
      .map((e) => e.name)
      .sort();
    if (!names.length) throw new Error('No audio was produced.');

    const base = file.name.replace(/\.[^.]+$/, '') || 'audio';
    const out = [];
    for (const name of names) {
      const data = await ffmpeg.readFile(name);
      written.push(name);
      out.push(new File([data.buffer], `${base}_${name}`, { type: 'audio/mp4' }));
    }
    return out;
  } finally {
    ffmpeg.off('progress', onProg);
    for (const n of written) { try { await ffmpeg.deleteFile(n); } catch {} }
    if (mounted) { try { await ffmpeg.unmount(dir); } catch {} }
    try { await ffmpeg.deleteDir(dir); } catch {}
  }
}
