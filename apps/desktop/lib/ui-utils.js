/**
 * MODULE: lib/ui-utils.js
 * PURPOSE: Single source of truth for pure UI formatting helpers shared by the
 *          browser-side components (renderer, drive-item, drive-info-panel,
 *          qr-scanner). Eliminates the previous 3-4x duplication of these
 *          functions, which was the exact "copy-paste then diverge" failure
 *          mode CLAUDE.md warns about.
 * LOAD ORDER: must be the FIRST <script> in index.html, before any component
 *          that delegates to it (scroll-list, drive-item, etc.).
 * EXPORTS (via window.PearUtils, also module.exports for Node unit tests):
 * formatBytes(bytes) - "1.5 MB"
 * formatSpeed(bytesPerSec) - "1.5 MB/s" (UI-tuned precision; '' for 0)
 * getFileIcon(filename) - emoji for a file extension
 * escapeHtml(text) - HTML-escape (also escapes quotes -> safe in
 *                                 attribute contexts, unlike the old DOM impl)
 * truncateMiddle(str, max) - "long…name"
 * KEY STATE: none (pure functions)
 */
(function (root) {
  'use strict';

  function formatBytes(bytes) {
    if (bytes == null || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec == null || bytesPerSec === 0) return '';
    const k = 1024;
    // Bytes - rare but handle it
    if (bytesPerSec < k) {
      return Math.round(bytesPerSec) + ' B/s';
    }
    // KB range
    const kb = bytesPerSec / k;
    if (kb < 100) return kb.toFixed(1) + ' KB/s';
    if (kb < 1000) return Math.round(kb) + ' KB/s';
    // MB range
    const mb = bytesPerSec / (k * k);
    if (mb < 10) return mb.toFixed(2) + ' MB/s';
    if (mb < 100) return mb.toFixed(1) + ' MB/s';
    return Math.round(mb) + ' MB/s';
  }

  const FILE_ICONS = {
    // Images
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    // Video
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
    // Audio
    mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵', m4a: '🎵',
    // Documents
    pdf: '📕', doc: '📘', docx: '📘', txt: '📄', md: '📝',
    // Archives
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    // Code
    js: '⚙️', ts: '⚙️', py: '🐍', html: '🌐', css: '🎨', json: '📋'
  };

  function getFileIcon(filename) {
    if (!filename) return '📄';
    const ext = filename.split('.').pop()?.toLowerCase();
    return FILE_ICONS[ext] || '📄';
  }

  // Regex-based escape: also escapes quotes, so it is correct in BOTH element
  // text and attribute contexts (the old DOM-innerHTML impl left quotes raw).
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(text) {
    if (text == null) return '';
    return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  function truncateMiddle(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    const half = Math.floor((maxLen - 3) / 2);
    return str.slice(0, half) + '...' + str.slice(-half);
  }

  const PearUtils = { formatBytes, formatSpeed, getFileIcon, escapeHtml, truncateMiddle };

  if (typeof module === 'object' && module.exports) module.exports = PearUtils;
  if (root) root.PearUtils = PearUtils;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
