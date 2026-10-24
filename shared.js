export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? "No response from background");
  return res.result;
}

export function safeFileName(title, ext) {
  const base = (title || "video")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in file names
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base || "video"}.${ext}`;
}

export function formatBytes(n) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 3 ? 2 : i ? 1 : 0)} ${units[i]}`;
}

export function extensionOf(url, fallback = "mp4") {
  return new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i)?.[1].toLowerCase() ?? fallback;
}
