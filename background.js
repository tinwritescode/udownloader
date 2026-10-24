// Sniffs media responses per tab, keeps the list in session storage (the
// service worker can be killed at any time), and sets Referer/Origin headers
// for extension-initiated fetches via declarativeNetRequest session rules.

const HLS_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"];
const DASH_TYPES = ["application/dash+xml"];
const SEGMENT_EXT = /\.(ts|m4s|aac|vtt|webvtt|key)(\?|$)/i;
const MIN_DIRECT_BYTES = 300 * 1024;

const referers = new Map(); // requestId -> Referer header seen on the request

const tabKey = (tabId) => `tab_${tabId}`;

async function readTab(tabId) {
  const key = tabKey(tabId);
  return (await chrome.storage.session.get(key))[key] ?? [];
}

async function writeTab(tabId, items) {
  await chrome.storage.session.set({ [tabKey(tabId)]: items });
  chrome.action.setBadgeText({ tabId, text: items.length ? String(items.length) : "" });
}

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
}

function classify(url, contentType) {
  const path = new URL(url).pathname.toLowerCase();
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (HLS_TYPES.includes(type) || path.endsWith(".m3u8")) return "hls";
  if (DASH_TYPES.includes(type) || path.endsWith(".mpd")) return "dash";
  if (SEGMENT_EXT.test(path)) return null;
  if (type.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v)$/.test(path)) return "direct";
  return null;
}

function totalSize(headers) {
  // Range responses carry the full size in Content-Range: bytes a-b/total.
  const range = header(headers, "content-range").match(/\/(\d+)$/);
  if (range) return Number(range[1]);
  return Number(header(headers, "content-length")) || 0;
}

// Serialize writes so concurrent responses don't drop each other's entries.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    const ref = header(d.requestHeaders, "referer");
    if (ref) referers.set(d.requestId, ref);
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const referer = referers.get(d.requestId) ?? "";
    referers.delete(d.requestId);
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const kind = classify(d.url, header(d.responseHeaders, "content-type"));
    if (!kind) return;
    const size = totalSize(d.responseHeaders);
    if (kind === "direct" && size && size < MIN_DIRECT_BYTES) return;
    serial(async () => {
      const items = await readTab(d.tabId);
      const existing = items.find((i) => i.url === d.url);
      if (existing) {
        existing.size ||= size;
        existing.referer ||= referer;
      } else {
        items.push({ url: d.url, kind, size, referer, seenAt: Date.now() });
      }
      await writeTab(d.tabId, items);
    });
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] },
  ["responseHeaders"],
);

chrome.webRequest.onErrorOccurred.addListener((d) => referers.delete(d.requestId), { urls: ["<all_urls>"] });

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // New top-level navigation: old page's media is gone.
  if (info.status === "loading" && info.url) serial(() => writeTab(tabId, []));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(() => chrome.storage.session.remove(tabKey(tabId)));
  clearHeaderRule(tabId);
});

// One session rule per download page tab, so rule ids never collide.
// (DNR does not apply to chrome.downloads requests, so all fetching that
// needs a Referer happens in the download page.)
const ruleId = (tabId) => tabId + 1;

async function setHeaderRule(tabId, referer) {
  const origin = new URL(referer).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId(tabId)],
    addRules: [
      {
        id: ruleId(tabId),
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "referer", operation: "set", value: referer },
            { header: "origin", operation: "set", value: origin },
          ],
        },
        condition: { tabIds: [tabId] },
      },
    ],
  });
}

function clearHeaderRule(tabId) {
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(tabId)] });
}

const handlers = {
  // Plain files stream to disk through Chrome's downloader, which handles any
  // size. That path can't carry a Referer (DNR skips chrome.downloads), so
  // probe first without one; a refusal means the page must fetch it instead.
  async downloadNative({ url, filename }) {
    try {
      const res = await fetch(url, { credentials: "include", headers: { Range: "bytes=0-0" } });
      res.body?.cancel();
      if (!res.ok) return null;
    } catch {
      return null;
    }
    return chrome.downloads.download({ url, filename, saveAs: false });
  },
  async list({ tabId }) {
    return readTab(tabId);
  },
  async useReferer({ referer }, sender) {
    if (referer) await setHeaderRule(sender.tab.id, referer);
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (result) => reply({ ok: true, result }),
    (error) => reply({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});
