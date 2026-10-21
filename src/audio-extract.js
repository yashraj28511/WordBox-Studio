
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_BASE =
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

// Keep WAV chunks below Vercel's 4.5 MB request-body limit.
const SEGMENT_SECONDS = 90;

let ffmpegPromise = null;

function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();

      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${CORE_BASE}/ffmpeg-core.js`,
          'text/javascript'
        ),
        wasmURL: await toBlobURL(
          `${CORE_BASE}/ffmpeg-core.wasm`,
          'application/wasm'
        )
      });

      return ffmpeg;
    })().catch((error) => {
      ffmpegPromise = null;
      throw error;
    });
  }

  return ffmpegPromise;
}

function isAudio(file) {
  if (file.type?.startsWith('audio/')) return true;

  return /\.(mp3|m4a|wav|aac|ogg|flac|opus|wma|mp4|mov|webm|mkv|avi)$/i
    .test(file.name);
}

/**
 * Extracts and converts audio to mono, 16 kHz, 16-bit PCM WAV.
 * Returns small WAV files in chronological order.
 */
export async function extractAudioChunks(
  file,
  onProgress = () => {}
) {
  if (!file || !file.size) {
    throw new Error('The selected file is empty.');
  }

  if (!isAudio(file)) {
    throw new Error('Please select a supported audio or video file.');
  }

  onProgress(0, 'Loading converter');

  const ffmpeg = await getFFmpeg();
  const inputDir = '/input';
  const inputName = file.name.replace(/[\\/]/g, '_');
  const inputPath = `${inputDir}/${inputName}`;
  const outputPattern = 'chunk_%03d.wav';

  const progressHandler = ({ progress }) => {
    if (Number.isFinite(progress)) {
      onProgress(
        Math.max(0, Math.min(1, progress)),
        'Extracting audio'
      );
    }
  };

  ffmpeg.on('progress', progressHandler);

  let mounted = false;
  const outputFiles = [];

  try {
    // Clean up chunks left over from an earlier run.
    const existingFiles = await ffmpeg.listDir('/');

    for (const entry of existingFiles) {
      if (!entry.isDir && /^chunk_\d+\.wav$/.test(entry.name)) {
        await ffmpeg.deleteFile(entry.name);
      }
    }

    await ffmpeg.createDir(inputDir);

    await ffmpeg.mount(
      'WORKERFS',
      { files: [file] },
      inputDir
    );

    mounted = true;

    onProgress(0.02, 'Converting audio');

    const exitCode = await ffmpeg.exec([
      '-hide_banner',
      '-i', inputPath,
      '-map', '0:a:0',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 'segment',
      '-segment_format', 'wav',
      '-segment_time', String(SEGMENT_SECONDS),
      '-reset_timestamps', '1',
      outputPattern
    ]);

    if (exitCode !== 0) {
      throw new Error(
        'Audio conversion failed. The file may be unsupported or contain no audio track.'
      );
    }

    const entries = await ffmpeg.listDir('/');

    const names = entries
      .filter(
        (entry) =>
          !entry.isDir && /^chunk_\d+\.wav$/.test(entry.name)
      )
      .map((entry) => entry.name)
      .sort();

    if (!names.length) {
      throw new Error('No audio chunks were generated.');
    }

    const baseName =
      file.name.replace(/\.[^.]+$/, '').replace(/[\\/]/g, '_') ||
      'audio';

    const chunks = [];

    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const data = await ffmpeg.readFile(name);

      if (!(data instanceof Uint8Array) || data.length === 0) {
        throw new Error(`Audio chunk ${index + 1} is empty.`);
      }

      // WAV files should begin with RIFF and WAVE markers.
      const validWav =
        data.length >= 12 &&
        String.fromCharCode(...data.slice(0, 4)) === 'RIFF' &&
        String.fromCharCode(...data.slice(8, 12)) === 'WAVE';

      if (!validWav) {
        throw new Error(
          `Chunk ${index + 1} is not a valid WAV file.`
        );
      }

      const chunk = new File(
        [data],
        `${baseName}_part_${String(index + 1).padStart(3, '0')}.wav`,
        { type: 'audio/wav' }
      );

      chunks.push(chunk);
      outputFiles.push(name);

      onProgress(
        0.1 + 0.9 * ((index + 1) / names.length),
        'Preparing audio chunks'
      );
    }

    return chunks;
  } finally {
    ffmpeg.off('progress', progressHandler);

    for (const name of outputFiles) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {}
    }

    if (mounted) {
      try {
        await ffmpeg.unmount(inputDir);
      } catch {}
    }

    try {
      await ffmpeg.deleteDir(inputDir);
    } catch {}
  }
}
