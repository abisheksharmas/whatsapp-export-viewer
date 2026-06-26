"use strict";

const DB_NAME = "whatsapp-archive-viewer";
const DB_VERSION = 1;
const ARCHIVE_STORE = "archives";
const MEDIA_STORE = "media";
const CURRENT_ARCHIVE_KEY = "wa-current-archive";
const {
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
  statDates: document.querySelector("#statDates"),
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
};

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
    const stats = summarizeArchive(messages, mediaData.records.length);
    const archive = {
      id: archiveId,
      title: archiveTitleFromFile(file),
      sourceFile: file.name,
      importedAt: new Date().toISOString(),
      messages,
      participants,
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
  state.archives = (await getAll(ARCHIVE_STORE)).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
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
  elements.statDates.textContent = formatNumber(archive.stats.dates);
  elements.chatTitle.textContent = archive.title;
  elements.chatSubtitle.textContent = `Imported ${imported} from ${archive.sourceFile}`;
}

function populateSenderFilter() {
  const current = elements.senderFilter.value;
  elements.senderFilter.replaceChildren(new Option("All senders", ""));

  state.archive.participants.forEach((sender) => {
    elements.senderFilter.append(new Option(sender, sender));
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
      if (type === "missing" && !message.missingMedia) return false;
      if (type !== "missing" && message.mediaType !== type) return false;
    }
    if (!query) return true;

    return [
      message.sender,
      message.text,
      message.rawText,
      message.mediaName,
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
  const firstSender = state.archive.messages.find((message) => !message.isSystem)?.sender || "";

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
    node.classList.add(message.isSystem ? "system" : message.sender === firstSender ? "outgoing" : "incoming");

    node.querySelector(".message-sender").textContent = message.sender;
    node.querySelector(".message-media").append(renderMedia(message));

    const textTarget = node.querySelector(".message-text");
    const displayText = message.text || (message.mediaName && !message.missingMedia ? message.mediaName : "");
    textTarget.append(highlightText(displayText, query));
    textTarget.hidden = !displayText;

    const typeTarget = node.querySelector(".message-type");
    typeTarget.textContent = message.mediaType === "text" || message.mediaType === "system" ? "" : message.mediaType;

    const time = node.querySelector("time");
    time.dateTime = message.timestamp;
    time.textContent = timeLabel(message.timestamp);

    elements.messageList.append(node);
  });

  const total = state.archive.messages.length;
  elements.resultBar.textContent = `${formatNumber(messages.length)} of ${formatNumber(total)} messages`;
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
}

init().catch((error) => {
  console.error(error);
  setStatus(error.message || "Unable to start app.", true);
});
