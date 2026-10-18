import { exiftool } from "exiftool-vendored";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BYTES = 4 * 1024 * 1024; // Netlify request-body limits apply before this function runs.
const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".m4v", ".heic", ".heif", ".avif", ".3gp"]);

export default async (request) => {
  if (request.method !== "POST") return Response.json({ error: "Use POST to upload a file." }, { status: 405 });
  let dir;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a file first." }, { status: 400 });
    if (!file.size) return Response.json({ error: "The uploaded file is empty." }, { status: 400 });
    if (file.size > MAX_BYTES) return Response.json({ error: "This serverless deployment accepts files up to 4 MB. Large video files need a dedicated processing server; they cannot be handled reliably by a Netlify Function." }, { status: 413 });
    const ext = path.extname(file.name || "").toLowerCase();
    if (!allowed.has(ext)) return Response.json({ error: "Unsupported file type. Try JPEG, PNG, WebP, GIF, MP4, MOV, M4V, HEIC, AVIF or 3GP." }, { status: 415 });
    dir = await mkdtemp(path.join(tmpdir(), "normark-nullframe-"));
    const input = path.join(dir, `input${ext}`);
    const output = path.join(dir, `output${ext}`);
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    // ExifTool performs server-side metadata removal; original media streams are not intentionally re-encoded.
    await copyFile(input, output);
    // Write to a copy so the original upload is never modified.
    // ExifTool's write API applies the same metadata deletion operation as -all=.
    await exiftool.write(output, { All: undefined }, { args: ["-all="] });
    const result = await readFile(output);
    const filename = (file.name || `clean${ext}`).replace(/[\\r\\n"]/g, "_");
    return new Response(result, {
      status: 200,
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Metadata-Removed": "ExifTool metadata cleanup completed",
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return Response.json({ error: `Could not process this file: ${String(error?.message || error).slice(0, 500)}` }, { status: 500 });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
