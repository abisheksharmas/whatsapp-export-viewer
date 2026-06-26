"use strict";

(function exposeParser(global) {
  const mediaExtensions = {
    image: new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"]),
    video: new Set(["mp4", "mov", "m4v", "3gp", "avi", "mkv", "webm"]),
    audio: new Set(["opus", "ogg", "mp3", "m4a", "aac", "wav", "amr"]),
    document: new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "zip"]),
  };

  function normalizeFilename(name) {
    return decodeURIComponent(String(name || ""))
      .split(/[\\/]/)
      .pop()
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/^["'<]+|[>"']+$/g, "")
      .trim()
      .toLowerCase();
  }

  function extensionOf(name) {
    const clean = normalizeFilename(name);
    const index = clean.lastIndexOf(".");
    return index >= 0 ? clean.slice(index + 1) : "";
  }

  function inferMediaType(name, mime = "") {
    const lowerMime = mime.toLowerCase();
    if (lowerMime.startsWith("image/")) return "image";
    if (lowerMime.startsWith("video/")) return "video";
    if (lowerMime.startsWith("audio/")) return "audio";

    const ext = extensionOf(name);
    if (mediaExtensions.image.has(ext)) return "image";
    if (mediaExtensions.video.has(ext)) return "video";
    if (mediaExtensions.audio.has(ext)) return "audio";
    if (mediaExtensions.document.has(ext)) return "document";
    return "document";
  }

  function parseDateParts(rawDate, rawTime) {
    const dateParts = rawDate.split(/[/. -]/).map((part) => Number(part));
    if (dateParts.length < 3 || dateParts.some(Number.isNaN)) return null;

    let [first, second, year] = dateParts;
    if (year < 100) year += 2000;

    let day = first;
    let month = second;
    if (first <= 12 && second > 12) {
      month = first;
      day = second;
    }

    const timeMatch = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
    if (!timeMatch) return null;

    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const secondValue = Number(timeMatch[3] || 0);
    const meridiem = (timeMatch[4] || "").replace(/\./g, "").toLowerCase();

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    const date = new Date(year, month - 1, day, hour, minute, secondValue);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function sanitizeLine(line) {
    return String(line || "").replace(/^[\u200e\u200f\u202a-\u202e]+/, "");
  }

  function matchMessageStart(line) {
    const cleanLine = sanitizeLine(line);
    const bracketed = cleanLine.match(/^\[(\d{1,2}[/. -]\d{1,2}[/. -]\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?)\]\s(.+)$/i);
    if (bracketed) {
      return {
        date: parseDateParts(bracketed[1], bracketed[2]),
        content: bracketed[3],
      };
    }

    const dashed = cleanLine.match(/^(\d{1,2}[/. -]\d{1,2}[/. -]\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?)\s+-\s+(.+)$/i);
    if (dashed) {
      return {
        date: parseDateParts(dashed[1], dashed[2]),
        content: dashed[3],
      };
    }

    return null;
  }

  function parseContent(content) {
    const separator = content.indexOf(": ");
    if (separator > 0) {
      return {
        sender: content.slice(0, separator).trim(),
        text: content.slice(separator + 2),
        isSystem: false,
      };
    }

    return {
      sender: "System",
      text: content.trim(),
      isSystem: true,
    };
  }

  function findMediaReference(text, mediaLookup) {
    const candidates = [];
    const attachedMatch = text.match(/<attached:\s*([^>]+)>/i);
    if (attachedMatch) candidates.push(attachedMatch[1]);

    const fileAttachedMatch = text.match(/([\w .()@+\-\[\]\u200e\u200f]+?\.[a-z0-9]{2,5})\s+\(file attached\)/i);
    if (fileAttachedMatch) candidates.push(fileAttachedMatch[1]);

    const omittedMatch = text.match(/([\w .()@+\-\[\]\u200e\u200f]+?\.[a-z0-9]{2,5}).*<media omitted>/i);
    if (omittedMatch) candidates.push(omittedMatch[1]);

    const genericMatches = text.matchAll(/([\w@+\-()[\]\u200e\u200f ]+\.(?:jpe?g|png|gif|webp|heic|heif|mp4|mov|m4v|3gp|opus|ogg|mp3|m4a|aac|wav|amr|pdf|docx?|xlsx?|pptx?|csv|txt|zip))/gi);
    for (const match of genericMatches) candidates.push(match[1]);

    for (const candidate of candidates) {
      const normalized = normalizeFilename(candidate);
      if (mediaLookup.has(normalized)) return mediaLookup.get(normalized);
    }

    if (/<media omitted>/i.test(text)) {
      return {
        missing: true,
        name: "Media omitted",
        type: "missing",
      };
    }

    return null;
  }

  function cleanMessageText(text, mediaReference) {
    let cleaned = text
      .replace(/<attached:\s*[^>]+>/gi, "")
      .replace(/\s*\(file attached\)\s*/gi, "")
      .replace(/<media omitted>/gi, "")
      .trim();

    if (mediaReference && mediaReference.name) {
      const escaped = mediaReference.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      cleaned = cleaned.replace(new RegExp(escaped, "gi"), "").trim();
    }

    return cleaned;
  }

  function parseChatExport(text, mediaLookup = new Map()) {
    const messages = [];
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    let current = null;

    for (const line of lines) {
      const start = matchMessageStart(line);
      if (start && start.date) {
        if (current) messages.push(current);
        const content = parseContent(start.content);
        current = {
          id: `m-${messages.length + 1}`,
          timestamp: start.date.toISOString(),
          sender: content.sender,
          rawText: content.text,
          isSystem: content.isSystem,
        };
      } else if (current) {
        current.rawText += `\n${line}`;
      } else if (line.trim()) {
        current = {
          id: "m-1",
          timestamp: new Date().toISOString(),
          sender: "System",
          rawText: line.trim(),
          isSystem: true,
        };
      }
    }

    if (current) messages.push(current);

    return messages.map((message) => {
      const mediaReference = findMediaReference(message.rawText, mediaLookup);
      const mediaType = message.isSystem
        ? "system"
        : mediaReference
          ? mediaReference.type
          : "text";
      const textValue = cleanMessageText(message.rawText, mediaReference);

      return {
        ...message,
        text: textValue,
        mediaKey: mediaReference && !mediaReference.missing ? mediaReference.key : null,
        mediaName: mediaReference ? mediaReference.name : "",
        mediaType,
        missingMedia: Boolean(mediaReference && mediaReference.missing),
      };
    });
  }

  function summarizeArchive(messages, mediaCount) {
    const senders = new Set();
    const dates = new Set();
    let mediaMessages = 0;

    messages.forEach((message) => {
      if (!message.isSystem) senders.add(message.sender);
      dates.add(message.timestamp.slice(0, 10));
      if (message.mediaType !== "text" && message.mediaType !== "system") mediaMessages += 1;
    });

    return {
      messages: messages.length,
      mediaFiles: mediaCount,
      mediaMessages,
      senders: senders.size,
      dates: dates.size,
    };
  }

  global.WhatsAppArchive = {
    inferMediaType,
    normalizeFilename,
    parseChatExport,
    summarizeArchive,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.WhatsAppArchive;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
