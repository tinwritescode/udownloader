// Container work via a bundled ffmpeg.wasm (single-threaded core, loaded
// from the extension package). Streams are copied, never re-encoded.
import { FFmpeg } from "./vendor/ffmpeg/index.js";

let ffmpeg = null;

async function load() {
  if (ffmpeg) return ffmpeg;
  const instance = new FFmpeg();
  await instance.load({
    coreURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm"),
  });
  ffmpeg = instance;
  return ffmpeg;
}

// inputs: [{ data: Blob, ext }]. Returns an MP4 Blob with the first input's
// video and, when given, the second input's audio.
export async function toMp4(inputs) {
  const ff = await load();
  const names = [];
  for (const [i, input] of inputs.entries()) {
    const name = `in${i}.${input.ext}`;
    await ff.writeFile(name, new Uint8Array(await input.data.arrayBuffer()));
    names.push(name);
  }
  const args = names.flatMap((n) => ["-i", n]);
  if (names.length > 1) args.push("-map", "0:v:0", "-map", "1:a:0");
  // ADTS AAC from TS segments needs the ASC header inside MP4.
  args.push("-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "out.mp4");
  const code = await ff.exec(args);
  try {
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    return new Blob([await ff.readFile("out.mp4")], { type: "video/mp4" });
  } finally {
    for (const n of [...names, "out.mp4"]) await ff.deleteFile(n).catch(() => {});
  }
}
