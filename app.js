"use strict";

const DB_NAME = "whatsapp-archive-viewer";
const DB_VERSION = 1;
const ARCHIVE_STORE = "archives";
const MEDIA_STORE = "media";
const CURRENT_ARCHIVE_KEY = "wa-current-archive";
const {
  cleanSenderName,
  extractUrls,
  inferMediaType,
  normalizeFilename,
  parseChatExport,
  summarizeArchive,
} = window.WhatsAppArchive;

const elements = {
  chatFile: document.querySelector("#chatFile"),
  mediaFiles: document.querySelector("#mediaFiles"),
  importButton: document.querySelector("#importButton"),
  importStatus: document.querySelector("#importStatus"),
  archiveList: document.querySelector("#archiveList"),
  refreshArchives: document.querySelector("#refreshArchives"),
  archiveMeta: document.querySelector("#archiveMeta"),
  statMessages: document.querySelector("#statMessages"),
  statMedia: document.querySelector("#statMedia"),
  statSenders: document.querySelector("#statSenders"),
  statLinks: document.querySelector("#statLinks"),
  aliasSearch: document.querySelector("#aliasSearch"),
  aliasList: document.querySelector("#aliasList"),
  saveAliases: document.querySelector("#saveAliases"),
  linkList: document.querySelector("#linkList"),
  insightList: document.querySelector("#insightList"),
  chatTitle: document.querySelector("#chatTitle"),
  chatSubtitle: document.querySelector("#chatSubtitle"),
  searchInput: document.querySelector("#searchInput"),
  senderFilter: document.querySelector("#senderFilter"),
  typeFilter: document.querySelector("#typeFilter"),
  dateJump: document.querySelector("#dateJump"),
  resultBar: document.querySelector("#resultBar"),
  messageList: document.querySelector("#messageList"),
  messageTemplate: document.querySelector("#messageTemplate"),
};

const state = {
  db: null,
  archives: [],
  archive: null,
  mediaUrls: new Map(),
  mediaRecords: new Map(),
  annotationSaveTimer: null,
};

const DEFAULT_SENDER_ALIASES = {
  "+91 86302 81239": "Nirvair",
  "+91 78991 11006": "Srikanth",
  "+91 99728 24301": "Vishnu",
  "+91 88675 33728": "Sanat",
  "+91 74052 80638": "Shukan",
  "+91 80564 01144": "Abid",
  "+91 97875 55277": "Fayaz",
  "+91 94821 16789": "Gowri",
  "+91 89587 98294": "Prajjwal",
  "+91 81056 95589": "Mahua",
  "+91 98307 21556": "Ruchika",
  "+91 98493 01879": "Neeraj",
  "+91 63835 02397": "Karthik",
  "+91 99019 54544": "Jaya",
  "+91 94452 17913": "Suresh",
};

const MENTOR_SENDERS = new Set(["+91 86302 81239", "+91 99728 24301"]);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
        db.createObjectStore(ARCHIVE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        const mediaStore = db.createObjectStore(MEDIA_STORE, { keyPath: "key" });
        mediaStore.createIndex("archiveId", "archiveId", { unique: false });
      }
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transaction(storeName, mode = "readonly") {
  return state.db.transaction(storeName, mode).objectStore(storeName);
}

function getAll(storeName) {
  return new Promise((resolve, reject) => {
    const request = transaction(storeName).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function putRecord(storeName, record) {
  return new Promise((resolve, reject) => {
    const request = transaction(storeName, "readwrite").put(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function putManyMedia(records) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(MEDIA_STORE, "readwrite");
    const store = tx.objectStore(MEDIA_STORE);
    records.forEach((record) => store.put(record));
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
}

function getMediaForArchive(archiveId) {
  return new Promise((resolve, reject) => {
    const request = transaction(MEDIA_STORE).index("archiveId").getAll(archiveId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function setStatus(message, isError = false) {
  elements.importStatus.textContent = message;
  elements.importStatus.classList.toggle("error", isError);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function createMediaRecords(files, archiveId) {
  const lookup = new Map();
  const records = [];

  Array.from(files || []).forEach((file) => {
    const normalized = normalizeFilename(file.name);
    if (!normalized) return;

    const record = {
      key: `${archiveId}:${normalized}`,
      archiveId,
      name: file.name,
      normalized,
      type: inferMediaType(file.name, file.type),
      mime: file.type,
      size: file.size,
      blob: file,
    };

    records.push(record);
    lookup.set(normalized, {
      key: record.key,
      name: record.name,
      type: record.type,
    });
  });

  return { records, lookup };
}

function archiveTitleFromFile(file) {
  return file.name.replace(/\.txt$/i, "").replace(/[_-]+/g, " ").trim() || "WhatsApp Export";
}

function isPhoneSender(sender) {
  return /^\+?\d|^\+/.test(String(sender || "").trim());
}

function autoAliasForSender(sender) {
  if (DEFAULT_SENDER_ALIASES[sender]) return DEFAULT_SENDER_ALIASES[sender];
  if (isPhoneSender(sender)) return "";
  const cleaned = cleanSenderName(sender);
  return cleaned === sender ? "" : cleaned;
}

function ensureArchiveShape(archive) {
  archive.senderAliases ||= {};
  applyDefaultAliases(archive);
  archive.annotations ||= {};
  archive.links ||= collectLinks(archive.messages || []);
  archive.insights ||= buildInsights(archive.messages || [], archive.links || []);
  archive.stats ||= summarizeArchive(archive.messages || [], 0);
  archive.stats.links = archive.links.length;
  return archive;
}

function applyDefaultAliases(archive) {
  Object.entries(DEFAULT_SENDER_ALIASES).forEach(([sender, alias]) => {
    if (!archive.senderAliases[sender]) {
      archive.senderAliases[sender] = alias;
    }
  });
}

function collectLinks(messages) {
  const links = [];
  const seen = new Set();

  messages.forEach((message) => {
    const urls = message.urls && message.urls.length ? message.urls : extractUrls(message.rawText || message.text);
    urls.forEach((url) => {
      const key = `${message.id}:${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      links.push({
        id: key,
        messageId: message.id,
        sender: message.sender,
        timestamp: message.timestamp,
        url,
        host: safeHost(url),
      });
    });
  });

  return links;
}

function safeHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "link";
  }
}

function buildInsights(messages, links) {
  const senderCounts = new Map();
  const keywordCounts = new Map();
  const mediaCounts = { image: 0, video: 0, audio: 0, document: 0 };
  const stopWords = new Set([
    "about", "after", "also", "because", "been", "from", "have", "just", "like", "more", "only", "that", "this", "with", "what", "when", "will", "your", "http", "https", "media", "omitted",
  ]);

  messages.forEach((message) => {
    if (!message.isSystem) {
      senderCounts.set(message.sender, (senderCounts.get(message.sender) || 0) + 1);
    }
    if (mediaCounts[message.mediaType] !== undefined) mediaCounts[message.mediaType] += 1;
    String(message.text || "")
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{3,}/g)
      ?.forEach((word) => {
        if (!stopWords.has(word)) keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
      });
  });

  return {
    topSenders: [...senderCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    topKeywords: [...keywordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    mediaCounts,
    linkHosts: [...links.reduce((map, link) => map.set(link.host, (map.get(link.host) || 0) + 1), new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  };
}

function getAlias(sender) {
  if (!state.archive) return cleanSenderName(sender);
  return state.archive.senderAliases?.[sender] || autoAliasForSender(sender) || cleanSenderName(sender) || sender;
}

function senderLabel(sender) {
  return getAlias(sender);
}

function isMentorSender(sender) {
  const alias = getAlias(sender).toLowerCase();
  return MENTOR_SENDERS.has(sender) || alias === "nirvair" || alias === "vishnu";
}

function getAnnotation(messageId) {
  if (!state.archive) return {};
  state.archive.annotations ||= {};
  state.archive.annotations[messageId] ||= { bookmarked: false, note: "", tags: "" };
  return state.archive.annotations[messageId];
}

function hasBookmark(message) {
  return Boolean(state.archive?.annotations?.[message.id]?.bookmarked);
}

async function persistArchive() {
  if (!state.archive) return;
  await putRecord(ARCHIVE_STORE, state.archive);
  const index = state.archives.findIndex((archive) => archive.id === state.archive.id);
  if (index >= 0) state.archives[index] = state.archive;
}

function scheduleAnnotationSave() {
  clearTimeout(state.annotationSaveTimer);
  state.annotationSaveTimer = setTimeout(() => {
    persistArchive().catch((error) => console.error(error));
  }, 400);
}

function renderAliasList() {
  elements.aliasList.replaceChildren();
  if (!state.archive) return;

  const query = normalizeSearch(elements.aliasSearch.value);
  const senderCounts = new Map(state.archive.insights?.topSenders || []);
  state.archive.messages.forEach((message) => {
    if (!message.isSystem && !senderCounts.has(message.sender)) {
      senderCounts.set(message.sender, 0);
    }
  });

  const senders = [...state.archive.participants]
    .filter((sender) => {
      if (!query) return true;
      return [sender, getAlias(sender)].some((value) => String(value).toLowerCase().includes(query));
    })
    .sort((a, b) => (senderCounts.get(b) || 0) - (senderCounts.get(a) || 0));

  if (!senders.length) {
    const empty = document.createElement("p");
    empty.className = "status-line";
    empty.textContent = "No senders found";
    elements.aliasList.append(empty);
    return;
  }

  senders.slice(0, 80).forEach((sender) => {
    const item = document.createElement("label");
    item.className = "alias-item";
    const count = state.archive.messages.filter((message) => message.sender === sender).length;
    item.innerHTML = `
      <span>
        <strong></strong>
        <small></small>
      </span>
      <input type="text" autocomplete="off">
    `;
    item.querySelector("strong").textContent = cleanSenderName(sender);
    item.querySelector("small").textContent = `${formatNumber(count)} messages`;
    const input = item.querySelector("input");
    input.value = state.archive.senderAliases?.[sender] || "";
    input.placeholder = isPhoneSender(sender) ? "Add name" : "Alias";
    input.dataset.sender = sender;
    elements.aliasList.append(item);
  });
}

async function saveAliases() {
  if (!state.archive) return;

  elements.aliasList.querySelectorAll("input[data-sender]").forEach((input) => {
    const sender = input.dataset.sender;
    const value = input.value.trim();
    if (value) {
      state.archive.senderAliases[sender] = value;
    } else {
      delete state.archive.senderAliases[sender];
    }
  });

  await persistArchive();
  populateSenderFilter();
  renderMessages();
  renderLinkList();
  renderInsights();
  setStatus("Aliases saved.");
}

function renderLinkList() {
  elements.linkList.replaceChildren();
  if (!state.archive) return;

  const links = state.archive.links || [];
  if (!links.length) {
    const empty = document.createElement("p");
    empty.className = "status-line";
    empty.textContent = "No links found";
    elements.linkList.append(empty);
    return;
  }

  links.slice(0, 60).forEach((link) => {
    const item = document.createElement("div");
    item.className = "link-item";
    item.innerHTML = `
      <a target="_blank" rel="noreferrer"></a>
      <span></span>
      <button type="button">Jump</button>
    `;
    const anchor = item.querySelector("a");
    anchor.href = link.url;
    anchor.textContent = link.host;
    item.querySelector("span").textContent = `${senderLabel(link.sender)} · ${dateLabel(link.timestamp)}`;
    item.querySelector("button").addEventListener("click", () => focusMessage(link.messageId));
    elements.linkList.append(item);
  });
}

function renderInsights() {
  elements.insightList.replaceChildren();
  if (!state.archive) return;

  const insights = state.archive.insights || buildInsights(state.archive.messages, state.archive.links || []);
  const groups = [
    ["Top senders", insights.topSenders?.map(([sender, count]) => [senderLabel(sender), count]) || []],
    ["Link domains", insights.linkHosts || []],
    ["Keywords", insights.topKeywords || []],
    ["Media", Object.entries(insights.mediaCounts || {}).filter(([, count]) => count)],
  ];

  groups.forEach(([title, rows]) => {
    const group = document.createElement("div");
    group.className = "insight-group";
    const heading = document.createElement("h3");
    heading.textContent = title;
    group.append(heading);

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.textContent = "None yet";
      group.append(empty);
    } else {
      rows.slice(0, 8).forEach(([label, count]) => {
        const row = document.createElement("div");
        row.className = "insight-row";
        row.innerHTML = "<span></span><strong></strong>";
        row.querySelector("span").textContent = label;
        row.querySelector("strong").textContent = formatNumber(count);
        group.append(row);
      });
    }

    elements.insightList.append(group);
  });
}

async function handleImport() {
  const file = elements.chatFile.files[0];
  if (!file) {
    setStatus("Choose a chat .txt file first.", true);
    return;
  }

  elements.importButton.disabled = true;
  setStatus("Reading export...");

  try {
    const archiveId = crypto.randomUUID ? crypto.randomUUID() : `archive-${Date.now()}`;
    const mediaData = createMediaRecords(elements.mediaFiles.files, archiveId);
    const chatText = await file.text();
    const messages = parseChatExport(chatText, mediaData.lookup);
    const participants = [...new Set(messages.filter((message) => !message.isSystem).map((message) => message.sender))].sort();
    const senderAliases = Object.fromEntries(participants.map((sender) => [sender, autoAliasForSender(sender)]).filter(([, alias]) => alias));
    const links = collectLinks(messages);
    const stats = summarizeArchive(messages, mediaData.records.length);
    stats.links = links.length;
    const archive = {
      id: archiveId,
      title: archiveTitleFromFile(file),
      sourceFile: file.name,
      importedAt: new Date().toISOString(),
      messages,
      participants,
      senderAliases,
      annotations: {},
      links,
      insights: buildInsights(messages, links),
      stats,
    };

    setStatus("Saving archive...");
    await putRecord(ARCHIVE_STORE, archive);
    if (mediaData.records.length) await putManyMedia(mediaData.records);
    localStorage.setItem(CURRENT_ARCHIVE_KEY, archiveId);

    setStatus(`Imported ${formatNumber(messages.length)} messages.`);
    await loadArchives();
    await loadArchive(archiveId);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Import failed.", true);
  } finally {
    elements.importButton.disabled = false;
  }
}

async function loadArchives() {
  state.archives = (await getAll(ARCHIVE_STORE)).map(ensureArchiveShape).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  renderArchiveList();
}

function renderArchiveList() {
  elements.archiveList.replaceChildren();

  if (!state.archives.length) {
    const empty = document.createElement("p");
    empty.className = "status-line";
    empty.textContent = "No saved archives";
    elements.archiveList.append(empty);
    return;
  }

  state.archives.forEach((archive) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `archive-item${state.archive && state.archive.id === archive.id ? " active" : ""}`;
    button.innerHTML = `
      <span>
        <strong></strong>
        <span></span>
      </span>
      <span aria-hidden="true">&rsaquo;</span>
    `;
    button.querySelector("strong").textContent = archive.title;
    button.querySelector("span span").textContent = `${formatNumber(archive.stats.messages)} messages`;
    button.addEventListener("click", () => loadArchive(archive.id));
    elements.archiveList.append(button);
  });
}

function revokeMediaUrls() {
  state.mediaUrls.forEach((url) => URL.revokeObjectURL(url));
  state.mediaUrls.clear();
  state.mediaRecords.clear();
}

async function loadArchive(archiveId) {
  const archive = state.archives.find((item) => item.id === archiveId);
  if (!archive) return;

  revokeMediaUrls();
  state.archive = archive;
  localStorage.setItem(CURRENT_ARCHIVE_KEY, archiveId);

  const mediaRecords = await getMediaForArchive(archiveId);
  mediaRecords.forEach((record) => {
    state.mediaRecords.set(record.key, record);
    state.mediaUrls.set(record.key, URL.createObjectURL(record.blob));
  });

  updateArchiveMeta();
  populateSenderFilter();
  renderAliasList();
  renderLinkList();
  renderInsights();
  renderArchiveList();
  renderMessages();
}

function updateArchiveMeta() {
  const archive = state.archive;
  if (!archive) return;

  const imported = new Date(archive.importedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  elements.archiveMeta.textContent = `${formatNumber(archive.stats.messages)} messages`;
  elements.statMessages.textContent = formatNumber(archive.stats.messages);
  elements.statMedia.textContent = formatNumber(archive.stats.mediaFiles);
  elements.statSenders.textContent = formatNumber(archive.stats.senders);
  elements.statLinks.textContent = formatNumber(archive.stats.links || 0);
  elements.chatTitle.textContent = archive.title;
  elements.chatSubtitle.textContent = `Imported ${imported} from ${archive.sourceFile}`;
}

function populateSenderFilter() {
  const current = elements.senderFilter.value;
  elements.senderFilter.replaceChildren(new Option("All senders", ""));

  state.archive.participants.forEach((sender) => {
    elements.senderFilter.append(new Option(senderLabel(sender), sender));
  });

  elements.senderFilter.value = state.archive.participants.includes(current) ? current : "";
}

function dateLabel(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeSearch(value) {
  return value.trim().toLowerCase();
}

function filteredMessages() {
  if (!state.archive) return [];

  const query = normalizeSearch(elements.searchInput.value);
  const sender = elements.senderFilter.value;
  const type = elements.typeFilter.value;

  return state.archive.messages.filter((message) => {
    if (sender && message.sender !== sender) return false;
    if (type) {
      if (type === "bookmarked" && !hasBookmark(message)) return false;
      if (type === "link" && !(message.urls && message.urls.length)) return false;
      if (type === "missing" && !message.missingMedia) return false;
      if (!["bookmarked", "link", "missing"].includes(type) && message.mediaType !== type) return false;
    }
    if (!query) return true;

    return [
      message.sender,
      getAlias(message.sender),
      message.text,
      message.rawText,
      message.mediaName,
      ...(message.urls || []),
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function highlightText(text, query) {
  if (!query) return document.createTextNode(text);

  const fragment = document.createDocumentFragment();
  const lowerText = text.toLowerCase();
  let cursor = 0;
  let index = lowerText.indexOf(query);

  while (index >= 0) {
    if (index > cursor) fragment.append(document.createTextNode(text.slice(cursor, index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + query.length);
    fragment.append(mark);
    cursor = index + query.length;
    index = lowerText.indexOf(query, cursor);
  }

  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}

function renderLinkedText(text, query) {
  const fragment = document.createDocumentFragment();
  const urlPattern = /(https?:\/\/[^\s<>()\]]+)/gi;
  let cursor = 0;

  for (const match of text.matchAll(urlPattern)) {
    const url = match[0].replace(/[.,;!?]+$/g, "");
    if (match.index > cursor) {
      fragment.append(highlightText(text.slice(cursor, match.index), query));
    }
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "inline-link";
    link.textContent = url;
    fragment.append(link);
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) fragment.append(highlightText(text.slice(cursor), query));
  return fragment;
}

function renderMedia(message) {
  const container = document.createDocumentFragment();

  if (message.missingMedia) {
    const missing = document.createElement("div");
    missing.className = "missing-media";
    missing.textContent = message.mediaName || "Missing media";
    container.append(missing);
    return container;
  }

  if (!message.mediaKey) return container;

  const url = state.mediaUrls.get(message.mediaKey);
  const record = state.mediaRecords.get(message.mediaKey);
  if (!url || !record) return container;

  if (message.mediaType === "image") {
    const frame = document.createElement("a");
    frame.className = "media-frame";
    frame.href = url;
    frame.target = "_blank";
    frame.rel = "noreferrer";
    const image = document.createElement("img");
    image.src = url;
    image.alt = message.mediaName || "Image";
    image.loading = "lazy";
    frame.append(image);
    container.append(frame);
    return container;
  }

  if (message.mediaType === "video") {
    const frame = document.createElement("div");
    frame.className = "media-frame";
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.preload = "metadata";
    frame.append(video);
    container.append(frame);
    return container;
  }

  if (message.mediaType === "audio") {
    const audio = document.createElement("audio");
    audio.className = "media-audio";
    audio.src = url;
    audio.controls = true;
    audio.preload = "metadata";
    container.append(audio);
    return container;
  }

  const link = document.createElement("a");
  link.className = "document-link";
  link.href = url;
  link.download = record.name;
  link.textContent = record.name;
  container.append(link);
  return container;
}

function renderMessages() {
  const messages = filteredMessages();
  const query = normalizeSearch(elements.searchInput.value);
  elements.messageList.replaceChildren();

  if (!state.archive) {
    return;
  }

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<h2>No messages found</h2><p>Adjust the filters and search.</p>";
    elements.messageList.append(empty);
    elements.resultBar.textContent = "No matching messages";
    return;
  }

  let lastDate = "";
  messages.forEach((message) => {
    const day = message.timestamp.slice(0, 10);
    if (day !== lastDate) {
      lastDate = day;
      const separator = document.createElement("div");
      separator.className = "date-separator";
      const label = document.createElement("span");
      label.textContent = dateLabel(message.timestamp);
      separator.append(label);
      elements.messageList.append(separator);
    }

    const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.date = day;
    node.dataset.messageId = message.id;
    node.classList.add(message.isSystem ? "system" : isMentorSender(message.sender) ? "outgoing" : "incoming");

    node.querySelector(".message-sender").textContent = senderLabel(message.sender);
    node.querySelector(".message-media").append(renderMedia(message));

    const textTarget = node.querySelector(".message-text");
    const displayText = message.text || (message.mediaName && !message.missingMedia ? message.mediaName : "");
    textTarget.append(renderLinkedText(displayText, query));
    textTarget.hidden = !displayText;

    const typeTarget = node.querySelector(".message-type");
    const annotation = getAnnotation(message.id);
    const tags = annotation.tags ? `#${annotation.tags.split(",").map((tag) => tag.trim()).filter(Boolean).join(" #")}` : "";
    typeTarget.textContent = tags || (message.mediaType === "text" || message.mediaType === "system" ? "" : message.mediaType);

    const bookmark = node.querySelector(".bookmark-button");
    bookmark.classList.toggle("active", Boolean(annotation.bookmarked));
    bookmark.textContent = annotation.bookmarked ? "★" : "☆";
    bookmark.addEventListener("click", () => {
      annotation.bookmarked = !annotation.bookmarked;
      bookmark.classList.toggle("active", annotation.bookmarked);
      bookmark.textContent = annotation.bookmarked ? "★" : "☆";
      scheduleAnnotationSave();
      if (elements.typeFilter.value === "bookmarked") renderMessages();
    });

    const noteInput = node.querySelector(".note-input");
    const tagInput = node.querySelector(".tag-input");
    noteInput.value = annotation.note || "";
    tagInput.value = annotation.tags || "";
    noteInput.addEventListener("input", () => {
      annotation.note = noteInput.value;
      scheduleAnnotationSave();
    });
    tagInput.addEventListener("input", () => {
      annotation.tags = tagInput.value;
      typeTarget.textContent = tagInput.value ? `#${tagInput.value.split(",").map((tag) => tag.trim()).filter(Boolean).join(" #")}` : "";
      scheduleAnnotationSave();
    });

    const time = node.querySelector("time");
    time.dateTime = message.timestamp;
    time.textContent = timeLabel(message.timestamp);

    elements.messageList.append(node);
  });

  const total = state.archive.messages.length;
  elements.resultBar.textContent = `${formatNumber(messages.length)} of ${formatNumber(total)} messages`;
}

function focusMessage(messageId) {
  if (!state.archive) return;

  if (!state.archive.messages.some((message) => message.id === messageId)) return;
  const current = elements.messageList.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (current) {
    current.scrollIntoView({ behavior: "smooth", block: "center" });
    current.classList.add("focused-message");
    setTimeout(() => current.classList.remove("focused-message"), 1800);
    return;
  }

  elements.searchInput.value = "";
  elements.senderFilter.value = "";
  elements.typeFilter.value = "";
  renderMessages();
  requestAnimationFrame(() => focusMessage(messageId));
}

function jumpToDate() {
  const value = elements.dateJump.value;
  if (!value) return;

  const target = elements.messageList.querySelector(`[data-date="${value}"]`);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function init() {
  state.db = await openDatabase();
  await loadArchives();

  const currentArchiveId = localStorage.getItem(CURRENT_ARCHIVE_KEY);
  const firstArchive = state.archives.find((archive) => archive.id === currentArchiveId) || state.archives[0];
  if (firstArchive) await loadArchive(firstArchive.id);

  elements.importButton.addEventListener("click", handleImport);
  elements.refreshArchives.addEventListener("click", loadArchives);
  elements.searchInput.addEventListener("input", renderMessages);
  elements.senderFilter.addEventListener("change", renderMessages);
  elements.typeFilter.addEventListener("change", renderMessages);
  elements.dateJump.addEventListener("change", jumpToDate);
  elements.aliasSearch.addEventListener("input", renderAliasList);
  elements.saveAliases.addEventListener("click", saveAliases);
}

init().catch((error) => {
  console.error(error);
  setStatus(error.message || "Unable to start app.", true);
});
