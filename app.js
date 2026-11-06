'use strict';

const $ = id => document.getElementById(id);
const CFG_KEY = 'notes.config';
const REPO_ID_KEY = 'notes.repoId';
// Older versions kept vault site names here, unencrypted, for the main search.
localStorage.removeItem('notes.vaultIndex');
// Set just before the app reloads itself for an update, so it comes back to the list it was on.
const STAY_ON_LIST_KEY = 'notes.stayOnList';
const MAX_UPLOADS_PER_CYCLE = 50; // GitHub limits content creation to about 80 writes a minute
const MAX_IMAGE_SIDE = 1600;
const IMAGE_PATH = /^\.\.\/images\/([0-9a-f]+\.(?:jpg|png|gif))$/;

// ---------- Local database ----------

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('notes-app', 2);
  req.onupgradeneeded = () => {
    for (const [store, keyPath] of [['notes', 'id'], ['images', 'name'], ['vault', 'id']]) {
      if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store, { keyPath });
    }
  };
  req.onsuccess = () => {
    req.result.onversionchange = () => req.result.close();
    resolve(req.result);
  };
  req.onerror = () => reject(req.error);
});

function tx(store, mode, work) {
  return dbReady.then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    work(t.objectStore(store), value => { result = value; });
    t.oncomplete = () => resolve(result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}
const getAll = () => tx('notes', 'readonly', (s, done) => { s.getAll().onsuccess = e => done(e.target.result); });
const getNote = id => tx('notes', 'readonly', (s, done) => { s.get(id).onsuccess = e => done(e.target.result); });
const removeNote = id => tx('notes', 'readwrite', s => { s.delete(id); });

// Runs change inside one transaction so edits made during a sync are never overwritten.
// change returns the note to store, or nothing to leave it alone.
const updateNote = (id, change) => tx('notes', 'readwrite', (s, done) => {
  s.get(id).onsuccess = e => {
    const next = change(e.target.result);
    if (next) s.put(next);
    done(next);
  };
});

const getImage = name => tx('images', 'readonly', (s, done) => { s.get(name).onsuccess = e => done(e.target.result); });
const getAllImages = () => tx('images', 'readonly', (s, done) => { s.getAll().onsuccess = e => done(e.target.result); });
const putImage = image => tx('images', 'readwrite', s => { s.put(image); });

// ---------- Note helpers ----------

const newId = () => Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8);

function makeNote(body, created, updated, title = '', favorite = false) {
  const now = new Date().toISOString();
  return { id: newId(), title, favorite, body, text: htmlToText(body), created: created || now, updated: updated || now, rev: 1, sha: null, dirty: true, deleted: false, trashed: '' };
}

const hasContent = n => Boolean((n.title || '').trim() || n.text.trim()) || /<img\b/i.test(n.body);
const titleOf = n => (n.title || '').trim() || (n.text.split('\n').find(l => l.trim()) || '').trim() || (/<img\b/i.test(n.body) ? '이미지 노트' : '빈 노트');

function tagsOf(text) {
  return [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map(m => m[1]))];
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

const parseHtml = html => new DOMParser().parseFromString(html, 'text/html');
const BLOCKS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'HR']);

function htmlToText(html) {
  let out = '';
  const breakLine = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue.replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === 'BR') { out += '\n'; return; }
    if (tag === 'INPUT') { out += node.hasAttribute('checked') ? '☑ ' : '☐ '; return; }
    const isBlock = BLOCKS.has(tag);
    if (isBlock) breakLine();
    node.childNodes.forEach(walk);
    if (tag === 'TD' || tag === 'TH') out += '\t';
    if (isBlock) breakLine();
  };
  walk(parseHtml(html).body);
  return out.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

const escapeHtml = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toFile(n) {
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="created" content="${n.created}">\n<meta name="updated" content="${n.updated}">\n<meta name="note-title" content="${escapeHtml(n.title || '')}">\n<meta name="favorite" content="${Boolean(n.favorite)}">\n${n.trashed ? `<meta name="trashed" content="${n.trashed}">\n` : ''}<title>${escapeHtml(titleOf(n))}</title>\n</head>\n<body>\n${n.body}\n</body>\n</html>\n`;
}

function fromFile(text) {
  const doc = parseHtml(text);
  const meta = name => {
    const el = doc.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : null;
  };
  const now = new Date().toISOString();
  const body = doc.body.innerHTML.trim();
  return { title: meta('note-title') || '', favorite: meta('favorite') === 'true', trashed: meta('trashed') || '', created: meta('created') || now, updated: meta('updated') || now, body, text: htmlToText(body) };
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(bin);
}
const toBase64 = text => bytesToBase64(new TextEncoder().encode(text));
const base64ToBytes = b64 => {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const fromBase64 = b64 => new TextDecoder().decode(base64ToBytes(b64));

// ---------- Images ----------

const nameToUrl = new Map();

function urlForImage(name, blob) {
  if (!nameToUrl.has(name)) nameToUrl.set(name, URL.createObjectURL(blob));
  return nameToUrl.get(name);
}

async function shrink(blob) {
  const type = (blob.type || '').toLowerCase();
  if (type === 'image/gif' && blob.size < 1024 * 1024) return { blob, ext: 'gif' };
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (type === 'image/png' && scale === 1 && blob.size < 300 * 1024) return { blob, ext: 'png' };
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  return { blob: jpeg, ext: 'jpg' };
}

// Images are named after their content, so the same picture is stored and uploaded once.
async function storeImage(source) {
  const { blob, ext } = await shrink(source);
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const name = [...new Uint8Array(hash)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('') + '.' + ext;
  if (!(await getImage(name))) await putImage({ name, blob, uploaded: false });
  return { name, url: urlForImage(name, blob) };
}

async function toEditorHtml(body) {
  const doc = parseHtml(body);
  for (const img of doc.querySelectorAll('img')) {
    const m = (img.getAttribute('src') || '').match(IMAGE_PATH);
    const stored = m && await getImage(m[1]);
    if (stored) {
      img.setAttribute('src', urlForImage(m[1], stored.blob));
      img.setAttribute('data-note-image', m[1]);
    }
  }
  return doc.body.innerHTML;
}

// The editor may rewrite an image's src to a data address, so the attribute is what identifies it.
function toStoredHtml(html) {
  const doc = parseHtml(html);
  for (const card of doc.querySelectorAll('.yt-card')) card.remove(); // drawn on screen only
  for (const img of doc.querySelectorAll('img[data-note-image]')) {
    img.setAttribute('src', `../images/${img.getAttribute('data-note-image')}`);
    img.removeAttribute('data-note-image');
  }
  return doc.body.innerHTML;
}

// ---------- Editor ----------

let editor = null;
let editorReady = null;
let loading = false;
let imageWork = Promise.resolve();

const darkMode = () => matchMedia('(prefers-color-scheme: dark)').matches;

// Black text pasted or imported from elsewhere would vanish on a dark page. This changes the
// display only; the note keeps its original colour unless the text sits on its own background.
const DARK_TEXT_COLORS = ['#000', '#000000', 'black', 'rgb(0, 0, 0)', 'rgb(0,0,0)', '#111', '#111111', '#222', '#222222', '#333', '#333333', 'rgb(51, 51, 51)', 'rgb(34, 34, 34)', 'rgb(17, 17, 17)'];
const DARK_CONTENT_STYLE = `
        html { color-scheme: dark; }
        html, body { background: #1b1a18; color: #ece9e2; }
        /* The dark skin paints links and the box around a link being edited the same blue. */
        a { color: #7db8ff; }
        .mce-content-body [data-mce-selected=inline-boundary] { background: #3a3226; }
        ::selection { background: #e29a4a; color: #1b1a18; }
        ${DARK_TEXT_COLORS.map(c => `[style*="color: ${c}"]:not([style*="background"]), [style*="color:${c}"]:not([style*="background"])`).join(', ')} { color: inherit !important; }`;

function ensureEditor() {
  if (editorReady) return editorReady;
  editorReady = new Promise(resolve => {
    tinymce.init({
      selector: '#editor',
      base_url: new URL('vendor/tinymce', location.href).href,
      suffix: '.min',
      language: 'ko_KR',
      language_url: 'vendor/tinymce/langs/ko_KR.js',
      plugins: 'lists table link autolink',
      menubar: false,
      statusbar: false,
      branding: false,
      promotion: false,
      height: '100%',
      skin: darkMode() ? 'oxide-dark' : 'oxide',
      content_css: darkMode() ? 'dark' : 'default',
      toolbar_mode: 'scrolling',
      toolbar: 'undo redo | blocks | bold italic underline strikethrough | forecolor backcolor | bullist numlist notecheck | table noteimage link | removeformat',
      table_toolbar: 'tableprops tabledelete | tableinsertrowbefore tableinsertrowafter tabledeleterow | tableinsertcolbefore tableinsertcolafter tabledeletecol | tablemergecells tablesplitcells | tablecellbackgroundcolor',
      // Dragging a column border widens that column and the table, instead of taking room from a
      // neighbour that may have none to give.
      table_column_resizing: 'resizetable',
      contextmenu: false,
      browser_spellcheck: true,
      convert_urls: false,
      // Tapping a link shows a small bar with an open button; Ctrl+click opens it on a PC.
      link_context_toolbar: true,
      link_default_protocol: 'https',
      automatic_uploads: false,
      paste_data_images: true,
      paste_merge_formats: false,
      paste_remove_styles_if_webkit: false,
      invalid_elements: 'script,iframe,object,embed,form,style,link,meta,base,button,select,textarea',
      extended_valid_elements: 'input[type|checked|disabled]',
      content_style: `
        body { max-width: 760px; margin: 16px auto; padding: 0 16px 40px; font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; }
        img { max-width: 100%; height: auto; }
        /* Text keeps its column, but a table may run past it to the right and, when wider than the
           page, scroll sideways; cells never squeeze a word into one letter per line. */
        html { overflow-x: auto; }
        table { max-width: none; font-size: 14px; }
        td, th { padding: 4px 6px; word-break: keep-all; }
        input[type=checkbox] { width: 16px; height: 16px; margin-right: 4px; vertical-align: -2px; }
        .yt-card { display: block; position: relative; width: 100%; max-width: 480px; aspect-ratio: 16 / 9; margin: 6px 0 10px; overflow: hidden; background: #000; border-radius: 10px; cursor: pointer; }
        .yt-card img, .yt-card iframe { display: block; width: 100%; height: 100%; border: 0; object-fit: cover; }
        .yt-card::after { content: ''; position: absolute; top: 50%; left: 50%; width: 64px; height: 44px; background: rgb(0 0 0 / 70%) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M9 7l8 5-8 5z' fill='white'/%3E%3C/svg%3E") center / 28px no-repeat; border-radius: 12px; transform: translate(-50%, -50%); }
        .yt-card.playing::after { display: none; }
        ::highlight(note-hit) { background: #ffe08a; color: #24221e; }
        ::highlight(note-current) { background: #f39a2d; color: #000; }${darkMode() ? DARK_CONTENT_STYLE : ''}`,
      paste_preprocess: (_, args) => { args.content = stylePastedTable(args.content); },
      setup: ed => {
        ed.ui.registry.addButton('notecheck', {
          text: '☑',
          tooltip: '체크박스',
          onAction: () => ed.insertContent('<input type="checkbox">&nbsp;'),
        });
        ed.ui.registry.addButton('noteimage', {
          icon: 'image',
          tooltip: '이미지 넣기',
          onAction: () => $('image-file').click(),
        });
        ed.on('init', () => {
          editor = ed;
          // The clipboard's <style> block is gone by the time the paste hook runs, so keep it here.
          ed.getBody().addEventListener('paste', e => {
            lastClipboardHtml = e.clipboardData ? e.clipboardData.getData('text/html') : '';
          }, true);
          ed.on('input Undo Redo ExecCommand', onEdit);
          ed.on('PastePostProcess SetContent', () => { if (!loading) processImages(); });
          ed.on('PastePostProcess', e => linkifyText(e.node));
          ed.on('click', e => {
            const card = e.target.closest && e.target.closest('.yt-card');
            if (card) { playVideo(card); return; }
            if (e.target.nodeName === 'INPUT' && e.target.type === 'checkbox') {
              if (e.target.hasAttribute('checked')) e.target.removeAttribute('checked');
              else e.target.setAttribute('checked', 'checked');
              onEdit();
            }
          });
          resolve(ed);
        });
      },
    });
  });
  return editorReady;
}

// Web addresses written as plain text; stops before Korean text written straight after one.
function findUrls(text) {
  const found = [];
  for (const m of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'\u0080-￿]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, '');
    if (url.length < 5 || /^www\.$/i.test(url)) continue;
    found.push({ start: m.index, end: m.index + url.length, text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
  }
  return found;
}

// Turns typed or pasted addresses into links; the autolink plugin only catches them as they are typed.
function linkifyText(root) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement.closest('a') && /https?:\/\/|www\./i.test(node.data)) nodes.push(node);
  }
  for (const node of nodes) {
    const urls = findUrls(node.data);
    if (!urls.length) continue;
    const parts = doc.createDocumentFragment();
    let at = 0;
    for (const url of urls) {
      parts.append(node.data.slice(at, url.start));
      const a = doc.createElement('a');
      a.href = url.href;
      a.textContent = url.text;
      parts.append(a);
      at = url.end;
    }
    parts.append(node.data.slice(at));
    node.replaceWith(parts);
  }
}

// ---------- YouTube ----------
// A YouTube link gets a thumbnail under it; the player loads only when the thumbnail is tapped,
// so opening a note asks YouTube for nothing. The cards are never saved: the note keeps the link.

function youtubeId(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/) || [])[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = url.searchParams.get('t') || url.searchParams.get('start') || '';
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  const start = m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
  return { id, start };
}

// ---------- List thumbnails ----------
// A note's first image, or else its first YouTube video, shown small on its row in the list.
// Image thumbnails are made once from the stored image and kept on this device only, in their
// own database; they are never synced. Rows load theirs only when they scroll into view.

const THUMB_SIDE = 144; // pixels: sharp at 48 points on a 3x screen
const thumbUrls = new Map(); // image name → object URL of its thumbnail
const thumbSources = new Map(); // note id → { body, src } for the body it was found in

const thumbDb = new Promise(resolve => {
  const req = indexedDB.open('notes-thumbs', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => resolve(null); // no cache: thumbnails are made again each time
});

function thumbSource(n) {
  const body = n.body || '';
  const hit = thumbSources.get(n.id);
  if (hit && hit.body === body) return hit.src;
  let src = null;
  const img = body.match(/<img\b[^>]*\bsrc="\.\.\/images\/([0-9a-f]+\.(?:jpg|png|gif))"/);
  if (img) src = { image: img[1] };
  else {
    for (const m of body.matchAll(/\bhref="([^"]+)"/g)) {
      const video = youtubeId(m[1].replace(/&amp;/g, '&'));
      if (video) { src = { video: video.id }; break; }
    }
  }
  thumbSources.set(n.id, { body, src });
  return src;
}

async function thumbBlob(name) {
  const db = await thumbDb;
  const cached = db && await new Promise(resolve => {
    const req = db.transaction('thumbs').objectStore('thumbs').get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
  if (cached) return cached;
  const image = await getImage(name);
  if (!image) return null; // not downloaded yet; the list is drawn again when it arrives
  const bitmap = await createImageBitmap(image.blob);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(THUMB_SIDE, side);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // under transparent parts, which a JPEG would turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  if (blob && db) db.transaction('thumbs', 'readwrite').objectStore('thumbs').put(blob, name);
  return blob;
}

function dropThumb(img) {
  const button = img.parentElement && img.parentElement.querySelector('button.with-thumb');
  if (button) button.classList.remove('with-thumb');
  img.remove();
}

async function loadThumb(img) {
  const name = img.dataset.image;
  let url = thumbUrls.get(name);
  if (!url) {
    const blob = await thumbBlob(name).catch(() => null);
    if (blob) {
      url = URL.createObjectURL(blob);
      thumbUrls.set(name, url);
    }
  }
  if (url) img.src = url;
  else dropThumb(img);
}

const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    loadThumb(e.target);
  }
}, { root: $('list'), rootMargin: '200px 0px' });

function thumbFor(n) {
  const src = thumbSource(n);
  if (!src) return null;
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.decoding = 'async';
  img.onerror = () => dropThumb(img);
  if (src.video) {
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = `https://i.ytimg.com/vi/${src.video}/mqdefault.jpg`;
  } else if (thumbUrls.has(src.image)) {
    img.src = thumbUrls.get(src.image);
  } else {
    img.dataset.image = src.image;
    thumbObserver.observe(img);
  }
  return img;
}

function decorateVideos() {
  if (!editor) return;
  const body = editor.getBody();
  const doc = editor.getDoc();
  const wanted = new Set();
  for (const a of body.querySelectorAll('a[href]')) {
    const video = youtubeId(a.getAttribute('href'));
    if (!video) continue;
    const next = a.nextElementSibling;
    if (next && next.classList.contains('yt-card') && next.dataset.yt === video.id) { wanted.add(next); continue; }
    const card = doc.createElement('span');
    card.className = 'yt-card';
    card.contentEditable = 'false';
    card.dataset.yt = video.id;
    card.dataset.start = String(video.start);
    card.setAttribute('data-mce-bogus', 'all'); // the editor leaves it out of the saved text and undo
    const img = doc.createElement('img');
    img.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
    img.alt = 'YouTube 영상, 눌러서 재생';
    img.dataset.ytThumb = '1';
    card.append(img);
    a.after(card);
    wanted.add(card);
  }
  // A card whose link was edited away goes too.
  for (const card of body.querySelectorAll('.yt-card')) if (!wanted.has(card)) card.remove();
}

function playVideo(card) {
  if (card.classList.contains('playing')) return;
  const frame = editor.getDoc().createElement('iframe');
  const start = Number(card.dataset.start) || 0;
  frame.src = `https://www.youtube-nocookie.com/embed/${card.dataset.yt}?autoplay=1&playsinline=1${start ? `&start=${start}` : ''}`;
  frame.title = 'YouTube 영상';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  // The app sends no referrer anywhere, but YouTube refuses to play embedded videos without one.
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  card.replaceChildren(frame);
  card.classList.add('playing');
}

// Excel puts cell colours in a <style> block as classes; move them onto the cells so they survive.
let lastClipboardHtml = '';
function stylePastedTable(content) {
  const raw = lastClipboardHtml;
  if (!/<table/i.test(content) || !/<style/i.test(raw)) return content;
  const rules = new Map();
  for (const m of raw.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) rules.set(m[1], m[2]);
  const source = [...parseHtml(raw).querySelectorAll('td,th')];
  const doc = parseHtml(content);
  const cells = [...doc.querySelectorAll('td,th')];
  const keep = /^(color|background|background-color|font-weight|font-style|text-align|text-decoration)$/;
  cells.forEach((cell, i) => {
    const from = source[i];
    if (!from) return;
    for (const cls of from.classList) {
      for (const decl of (rules.get(cls) || '').split(';')) {
        const at = decl.indexOf(':');
        if (at < 0) continue;
        const prop = decl.slice(0, at).trim().toLowerCase();
        const value = decl.slice(at + 1).trim();
        if (keep.test(prop) && !/mso|windowtext/i.test(value) && !cell.style.getPropertyValue(prop)) {
          cell.style.setProperty(prop, value);
        }
      }
    }
  });
  return doc.body.innerHTML;
}

// Pasted or dropped pictures arrive as data or blob addresses; swap them for stored copies.
function processImages() {
  imageWork = imageWork.then(async () => {
    if (!editor) return;
    let changed = false;
    for (const img of [...editor.getBody().querySelectorAll('img')]) {
      const src = img.getAttribute('src') || '';
      if (img.hasAttribute('data-note-image') || img.closest('.yt-card') || IMAGE_PATH.test(src)) continue;
      changed = true;
      if (/^(data|blob):/.test(src)) {
        try {
          const blob = await (await fetch(src)).blob();
          const { name, url } = await storeImage(blob);
          editor.dom.setAttribs(img, { src: url, 'data-mce-src': url, 'data-note-image': name });
        } catch {
          img.replaceWith(editor.getDoc().createTextNode('[이미지를 넣지 못했어요]'));
        }
      } else {
        // Web images are not stored or loaded from outside; keep a link to them instead.
        const a = editor.getDoc().createElement('a');
        a.href = src;
        a.textContent = `[이미지 링크] ${src}`;
        img.replaceWith(a);
      }
    }
    if (changed) onEdit();
  }).catch(() => {});
  return imageWork;
}

async function insertImages(files) {
  await ensureEditor();
  for (const file of files) {
    try {
      const { name, url } = await storeImage(file);
      editor.insertContent(`<img src="${url}" data-note-image="${name}" alt="">`);
    } catch {
      toast(`이미지를 읽지 못했어요: ${file.name}`);
    }
  }
  onEdit();
}

// ---------- List and note view ----------

let currentId = null;
let activeTag = null;
let saveTimer = null;
let savedValue = '';
let savedTitle = '';
let loadedBody = '';

function countMatches(text, q) {
  let count = 0;
  for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) count += 1;
  return count;
}

const searchableText = n => `${n.title || ''} ${n.text}`.replace(/\s+/g, ' ').toLowerCase();

function appendSnippet(el, note, q) {
  const flat = note.text.replace(/\s+/g, ' ');
  const at = q ? flat.toLowerCase().indexOf(q) : -1;
  if (at < 0) {
    const lines = note.text.split('\n').filter(l => l.trim());
    const first = ((note.title || '').trim() ? lines : lines.slice(1)).join(' ');
    el.textContent = `${formatDate(note.updated)}  ${first.slice(0, 80)}`;
    return;
  }
  const count = countMatches(flat.toLowerCase(), q);
  const start = Math.max(0, at - 20);
  const mark = document.createElement('mark');
  mark.textContent = flat.slice(at, at + q.length);
  el.append(
    `${count}곳  ${start ? '…' : ''}${flat.slice(start, at)}`,
    mark,
    flat.slice(at + q.length, at + q.length + 50),
  );
}

// ---------- Note order ----------
// The list keeps the order it is dragged into. The order lives in its own repository file,
// merged note by note like the to-do list, so reordering never rewrites the notes themselves.

const ORDER_KEY = 'notes.order';
const ORDER_FILE = 'notes-order.json';
let orderEditing = false;
let renderPending = false;

function loadOrder() {
  try {
    const state = JSON.parse(localStorage.getItem(ORDER_KEY));
    if (state && state.items && typeof state.items === 'object') return state;
  } catch { /* unreadable; start empty */ }
  return { items: {}, sha: null, dirty: false };
}
const saveOrder = state => localStorage.setItem(ORDER_KEY, JSON.stringify(state));
const canonOrder = items => JSON.stringify(Object.keys(items).sort().map(id => [id, Object.keys(items[id]).sort().map(k => [k, items[id][k]])]));

// Each entry is a note's place ({ order, parent }) or a folder ({ kind: 'folder', name, favorite,
// order, deleted }); the most recent change to an entry wins when devices merge.
function editPlaces(changes) {
  const state = loadOrder();
  const now = new Date().toISOString();
  for (const [id, fields] of Object.entries(changes)) state.items[id] = { ...state.items[id], ...fields, updated: now };
  state.dirty = true;
  saveOrder(state);
  scheduleSync(3000);
}
const setOrders = orders => editPlaces(Object.fromEntries(Object.entries(orders).map(([id, order]) => [id, { order }])));
const topOrderValue = () => Math.min(0, ...Object.values(loadOrder().items).map(i => i.order)) - 1;

// New notes, and notes or folders that change section (a favourite added or removed, a note
// restored or moved into a folder), go to the top.
function putOnTop(id) {
  setOrders({ [id]: topOrderValue() });
}

// An edited note goes to the top of its section, and its folder to the top of the folder's.
// Once per opening, so typing does not keep rewriting the order.
let raisedId = null;
function raiseEdited(id) {
  const top = topOrderValue();
  const folder = folderOf(id);
  setOrders(folder ? { [id]: top, [folder.id]: top - 1 } : { [id]: top });
}

// ---------- Folders ----------
// One level: a folder holds notes, never folders. Notes in a folder cannot be favourites; the
// folder itself can, and then moves to the favourites as a whole.

const OPEN_FOLDERS_KEY = 'notes.openFolders';

function liveFolders(items = loadOrder().items) {
  return Object.entries(items)
    .filter(([, i]) => i.kind === 'folder' && !i.deleted)
    .map(([id, i]) => ({ id, ...i }))
    .sort((a, b) => a.order - b.order);
}

function folderOf(id, items = loadOrder().items) {
  const parent = items[id] && items[id].parent;
  const folder = parent && items[parent];
  return folder && folder.kind === 'folder' && !folder.deleted ? { id: parent, ...folder } : null;
}

function openFolders() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY)) || []); } catch { return new Set(); }
}

function toggleFolderOpen(id) {
  const open = openFolders();
  if (open.has(id)) open.delete(id);
  else open.add(id);
  localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...open]));
  render();
}

async function moveToFolder(noteId, folderId) {
  const note = await getNote(noteId);
  if (!note) return;
  editPlaces({ [noteId]: { parent: folderId || '', order: topOrderValue() } });
  if (folderId && note.favorite) {
    await toggleFavorite(noteId, true);
    toast('즐겨찾기를 해제하고 폴더로 옮겼어요.');
  } else if (folderId) {
    toast(`'${loadOrder().items[folderId].name}' 폴더로 옮겼어요.`);
  } else {
    toast('폴더 밖으로 꺼냈어요.');
  }
  if (folderId) {
    const open = openFolders();
    open.add(folderId);
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...open]));
  }
  if (noteId === currentId) showFavorite(note);
  await render();
}

function openFolderMove() {
  toggleNoteMenu(false);
  if (!currentId) return;
  const current = folderOf(currentId);
  const choices = [];
  if (current) choices.push({ id: '', name: '폴더 밖으로 꺼내기' });
  for (const f of liveFolders()) if (!current || f.id !== current.id) choices.push({ id: f.id, name: `📁 ${f.name}` });
  $('folder-choices').replaceChildren(...choices.map(c => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.name;
    b.onclick = () => { $('folder-move').close(); moveToFolder(currentId, c.id); };
    li.append(b);
    return li;
  }));
  $('folder-new').value = '';
  $('folder-move').showModal();
}

function createFolder(e) {
  e.preventDefault();
  const name = $('folder-new').value.trim();
  if (!name || !currentId) return;
  const id = newId();
  editPlaces({ [id]: { kind: 'folder', name, favorite: false, deleted: '', order: topOrderValue() } });
  $('folder-move').close();
  moveToFolder(currentId, id);
}

let editingFolderId = null;
function openFolderEdit(id) {
  editingFolderId = id;
  const folder = loadOrder().items[id];
  $('folder-name').value = folder.name;
  $('folder-favorite').textContent = folder.favorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기에 추가';
  $('folder-edit').showModal();
}

function saveFolderName() {
  const name = $('folder-name').value.trim();
  if (name && editingFolderId) editPlaces({ [editingFolderId]: { name } });
  $('folder-edit').close();
  render();
}

// The notes inside come out to the top level; nothing is deleted but the folder.
function deleteFolder() {
  const id = editingFolderId;
  if (!id) return;
  const items = loadOrder().items;
  const changes = { [id]: { deleted: new Date().toISOString() } };
  for (const [noteId, entry] of Object.entries(items)) if (entry.parent === id) changes[noteId] = { parent: '' };
  editPlaces(changes);
  $('folder-edit').close();
  toast('폴더를 삭제했어요. 안의 노트는 바깥으로 나왔어요.');
  render();
}

function toggleFolderFavorite(id) {
  const folder = loadOrder().items[id];
  editPlaces({ [id]: { favorite: !folder.favorite, order: topOrderValue() } });
  render();
}

// Notes without a place yet (all of them on first use, or one that arrived before the order
// file) go below the rest, newest first. Undated, so a place set on any device wins the merge.
function placeMissing(notes) {
  const state = loadOrder();
  const missing = notes.filter(n => !state.items[n.id]).sort((a, b) => b.updated.localeCompare(a.updated));
  if (!missing.length) return state.items;
  let next = Math.max(-1, ...Object.values(state.items).map(i => i.order)) + 1;
  for (const n of missing) state.items[n.id] = { order: next++, parent: '', updated: '' };
  state.dirty = true;
  saveOrder(state);
  return state.items;
}

async function syncOrder(cfg, remoteSha) {
  let state = loadOrder();
  if (remoteSha && remoteSha !== state.sha) {
    const blob = await api(cfg, `/repos/${cfg.repo}/git/blobs/${remoteSha}`);
    const theirs = JSON.parse(fromBase64(blob.content)).items || {};
    state = loadOrder(); // drags made while downloading
    const merged = { ...theirs };
    for (const [id, mine] of Object.entries(state.items)) {
      if (!merged[id] || mine.updated > merged[id].updated) merged[id] = mine;
    }
    state = { items: merged, sha: remoteSha, dirty: canonOrder(merged) !== canonOrder(theirs) };
    saveOrder(state);
  } else if (!remoteSha && state.sha) {
    state = { ...state, sha: null, dirty: Object.keys(state.items).length > 0 };
    saveOrder(state);
  }
  if (!state.dirty) return 0;
  const sent = state.items;
  const res = await api(cfg, `/repos/${cfg.repo}/contents/${ORDER_FILE}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: '노트 순서',
      content: toBase64(JSON.stringify({ version: 1, items: sent })),
      ...(state.sha ? { sha: state.sha } : {}),
    }),
  });
  const now = loadOrder();
  saveOrder({ ...now, sha: res.content.sha, dirty: canonOrder(now.items) !== canonOrder(sent) });
  return 1;
}

function resetOrderSync() {
  const state = loadOrder();
  saveOrder({ ...state, sha: null, dirty: Object.keys(state.items).length > 0 });
}

function toggleOrderEditing() {
  orderEditing = !orderEditing;
  if (orderEditing) {
    $('search').value = '';
    activeTag = null;
  }
  $('order-edit').textContent = orderEditing ? '완료' : '순서 편집';
  $('order-edit').classList.toggle('on', orderEditing);
  $('order-hint').hidden = !orderEditing;
  render();
}

// Same as dragging a to-do: only the handle starts it, and the neighbours move around the row.
function startNoteDrag(e, li) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  // Rows move among their own siblings: top-level rows in a section, or notes inside one folder.
  const list = li.parentElement;
  const scrollBox = $('list');
  const section = li.dataset.section;
  const ids = () => [...list.children].filter(x => x.dataset.section === section).map(x => x.dataset.note);
  const before = ids().join();
  let y = e.clientY;
  handle.setPointerCapture(e.pointerId);
  li.classList.add('dragging');
  document.body.classList.add('list-dragging');
  const same = x => x && x.dataset.section === section;
  const middle = x => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; };
  const place = () => {
    for (;;) {
      const prev = li.previousElementSibling;
      const next = li.nextElementSibling;
      if (same(next) && middle(next) < y) list.insertBefore(next, li);
      else if (same(prev) && middle(prev) > y) list.insertBefore(prev, next);
      else break;
    }
  };
  const scroller = setInterval(() => {
    const r = scrollBox.getBoundingClientRect();
    if (y < r.top + 50) scrollBox.scrollTop -= 10;
    else if (y > r.bottom - 50) scrollBox.scrollTop += 10;
    else return;
    place();
  }, 16);
  const move = ev => { y = ev.clientY; place(); };
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(scroller);
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) handle.removeEventListener(type, type === 'pointermove' ? move : end);
    li.classList.remove('dragging');
    document.body.classList.remove('list-dragging');
    const order = ids();
    if (order.join() !== before) setOrders(Object.fromEntries(order.map((id, i) => [id, i])));
    if (renderPending || order.join() !== before) render();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
}

async function render() {
  // A sync must not redraw the list under a finger dragging in it.
  if (document.body.classList.contains('list-dragging')) { renderPending = true; return; }
  renderPending = false;
  const all = (await getAll()).filter(n => !n.deleted && !n.trashed);
  // Blank notes stay hidden from the list unless they are the one being edited.
  const visible = all.filter(n => hasContent(n) || n.id === currentId);
  const places = placeMissing(visible);
  const tags = [...new Set(visible.flatMap(n => tagsOf(`${n.title || ''} ${n.text}`)))].sort((a, b) => a.localeCompare(b, 'ko'));
  if (activeTag && !tags.includes(activeTag)) activeTag = null;

  $('tags').replaceChildren(...tags.map(tag => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '#' + tag;
    b.className = tag === activeTag ? 'on' : '';
    b.onclick = () => { activeTag = tag === activeTag ? null : tag; render(); };
    return b;
  }));

  const q = $('search').value.trim().toLowerCase();
  const shown = visible
    .filter(n => !q || searchableText(n).includes(q))
    .filter(n => !activeTag || tagsOf(`${n.title || ''} ${n.text}`).includes(activeTag))
    .sort((a, b) => places[a.id].order - places[b.id].order || b.updated.localeCompare(a.updated));

  // Searching lists matching notes flat, each with its folder; otherwise folders hold their notes.
  const flat = Boolean(q || activeTag);
  const folders = flat ? [] : liveFolders(places);
  const inFolder = n => folderOf(n.id, places);
  const top = shown.filter(n => flat || !inFolder(n));
  const childrenOf = id => shown.filter(n => !flat && places[n.id].parent === id);
  const byPlace = (a, b) => places[a.id].order - places[b.id].order;
  const favorites = [...top.filter(n => n.favorite && !inFolder(n)), ...folders.filter(f => f.favorite)].sort(byPlace);
  const others = [...top.filter(n => !n.favorite || inFolder(n)), ...folders.filter(f => !f.favorite)].sort(byPlace);
  $('order-edit').hidden = shown.length + folders.length < 2 && !orderEditing;
  const editingOrder = orderEditing && !flat; // a filtered list would number only the notes it shows
  const handleFor = li => {
    const handle = document.createElement('span');
    handle.className = 'todo-handle list-handle';
    handle.title = '끌어서 순서 바꾸기';
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', e => startNoteDrag(e, li));
    return handle;
  };
  const open = openFolders();
  const label = text => {
    const li = document.createElement('li');
    li.className = 'label';
    li.textContent = text;
    return li;
  };
  // Notes are starred from their own page; only folders carry a button here.
  const folderMenuButton = f => {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'folder-more';
    more.textContent = '⋮';
    more.setAttribute('aria-label', `${f.name} 폴더 편집`);
    more.onclick = () => openFolderEdit(f.id);
    return more;
  };
  const noteRow = (n, section) => {
    const li = document.createElement('li');
    li.dataset.note = n.id;
    li.dataset.section = section;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = n.id === currentId ? 'note on' : 'note';
    b.classList.toggle('with-handle', editingOrder);
    const title = document.createElement('strong');
    title.textContent = titleOf(n);
    const sub = document.createElement('span');
    const folder = flat && inFolder(n);
    if (folder) sub.append(`📁 ${folder.name} · `);
    appendSnippet(sub, n, q);
    b.append(title, sub);
    b.onclick = () => openNote(n.id);
    li.append(b);
    if (editingOrder) li.append(handleFor(li));
    else {
      const thumb = thumbFor(n);
      if (thumb) {
        b.classList.add('with-thumb');
        li.append(thumb);
      }
    }
    return li;
  };
  const folderRow = (f, section) => {
    const li = document.createElement('li');
    li.className = 'folder';
    li.dataset.note = f.id;
    li.dataset.section = section;
    const kids = childrenOf(f.id);
    const isOpen = open.has(f.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'folder-head';
    b.setAttribute('aria-expanded', String(isOpen));
    const title = document.createElement('strong');
    const name = document.createElement('b');
    name.textContent = f.name;
    title.append(name);
    const count = document.createElement('span');
    count.textContent = `노트 ${kids.length}개`;
    b.append(title, count);
    b.onclick = () => toggleFolderOpen(f.id);
    li.append(b);
    li.append(editingOrder ? handleFor(li) : folderMenuButton(f));
    if (isOpen) {
      const ul = document.createElement('ul');
      ul.className = 'folder-notes';
      ul.append(...kids.map(n => noteRow(n, `in:${f.id}`)));
      if (!kids.length) {
        const none = document.createElement('li');
        none.className = 'label';
        none.textContent = '비어 있어요. 노트의 ⋯ 메뉴에서 이 폴더로 옮기세요.';
        ul.append(none);
      }
      li.append(ul);
    }
    return li;
  };
  const notesLabel = () => {
    const li = label('');
    li.classList.add('notes-label');
    const icon = document.createElement('b');
    icon.className = 'head-icon';
    icon.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="1.5" width="9" height="11" rx="1.5"/><path d="M5 5h4M5 7.5h4M5 10h2.5"/></svg>';
    li.append(icon, '노트');
    return li;
  };
  const row = section => item => (item.kind === 'folder' ? folderRow(item, section) : noteRow(item, section));
  // Favourite rows share one card; dragging still moves them among their own siblings.
  const favCard = () => {
    const li = document.createElement('li');
    li.className = 'fav-card';
    const head = document.createElement('div');
    head.className = 'fav-label';
    const star = document.createElement('b');
    star.className = 'head-icon';
    star.textContent = '★';
    head.append(star, '즐겨찾기');
    const ul = document.createElement('ul');
    ul.className = 'fav-list';
    ul.append(...favorites.map(row('favorite')));
    li.append(head, ul);
    return li;
  };
  $('list').replaceChildren(
    // todo.js may still be loading on the first draw; it draws the list again once it is in.
    ...(q || activeTag || typeof todoEntry !== 'function' ? [] : [todoEntry()]),
    ...(favorites.length ? [favCard()] : []),
    ...(favorites.length && others.length ? [notesLabel()] : []),
    ...others.map(row('note')),
  );

  const empty = $('empty');
  empty.hidden = shown.length > 0;
  empty.textContent = q || activeTag ? '찾는 노트가 없어요.' : '아직 노트가 없어요. ＋ 버튼으로 시작하세요.';
  if ($('trash').open) await renderTrash();
  if ($('todo').open) renderTodos();
}

function onEdit() {
  if (loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { decorateVideos(); flushEditor(); }, 600);
  if (!$('find-bar').hidden) scheduleFind();
}

async function flushEditor() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!currentId || !editor) return;
  await imageWork;
  const id = currentId;
  const body = toStoredHtml(editor.getContent());
  const title = $('note-title').value;
  if (body === savedValue && title === savedTitle) return;
  const bodyChanged = body !== savedValue;
  savedValue = body;
  savedTitle = title;
  if (bodyChanged) loadedBody = body;
  const text = htmlToText(body);
  await updateNote(id, n => {
    if (!n) return;
    n.title = title;
    if (bodyChanged) {
      n.body = body;
      n.text = text;
    }
    n.updated = new Date().toISOString();
    n.rev += 1;
    n.dirty = true;
    return n;
  });
  $('edited').textContent = '저장됨 ' + formatDate(new Date().toISOString());
  if (raisedId !== id) {
    raisedId = id;
    raiseEdited(id);
  }
  render();
  scheduleSync(3000);
}

async function discardIfBlank() {
  if (!currentId) return;
  const n = await getNote(currentId);
  if (n && !n.sha && !hasContent(n)) await removeNote(n.id);
}

async function loadIntoEditor(n, keepPlace) {
  const html = await toEditorHtml(n.body);
  loading = true;
  const place = keepPlace ? editor.selection.getBookmark(2, true) : null;
  editor.setContent(html);
  linkifyText(editor.getBody());
  decorateVideos();
  if (place) { try { editor.selection.moveToBookmark(place); } catch { /* the text moved away */ } }
  editor.undoManager.clear();
  loading = false;
  // The editor tidies HTML when loading; compare later edits against its own version.
  savedValue = toStoredHtml(editor.getContent());
  loadedBody = n.body;
  savedTitle = n.title || '';
  $('note-title').value = savedTitle;
  showFavorite(n);
}

function showFavorite(n) {
  const star = $('favorite');
  star.hidden = Boolean(folderOf(n.id)); // a note in a folder cannot be a favourite
  star.textContent = n.favorite ? '★' : '☆';
  star.classList.toggle('on', Boolean(n.favorite));
  star.setAttribute('aria-pressed', String(Boolean(n.favorite)));
}

// Marking a favorite is not an edit, so the note keeps its date. Unstarring it on the way into
// a folder leaves the place the folder move gave it.
async function toggleFavorite(id, intoFolder) {
  if (!intoFolder && folderOf(id)) return;
  const note = await updateNote(id, n => {
    if (!n) return;
    n.favorite = !n.favorite;
    n.rev += 1;
    n.dirty = true;
    return n;
  });
  if (note && id === currentId) showFavorite(note);
  if (note && !intoFolder) putOnTop(id);
  await render();
  scheduleSync(1000);
}

function hideEditor() {
  toggleNoteMenu(false);
  currentId = null;
  savedValue = '';
  savedTitle = '';
  loadedBody = '';
  $('note-title').value = '';
  closeFind();
  if (editor) { loading = true; editor.setContent(''); loading = false; }
  $('editor-wrap').hidden = true;
  $('placeholder').hidden = false;
  document.body.classList.remove('editing');
}

async function showNote(n, fromSearch) {
  $('placeholder').hidden = true;
  $('editor-wrap').hidden = false;
  document.body.classList.add('editing');
  if (history.state && history.state.note) history.replaceState({ note: true }, '');
  else history.pushState({ note: true }, '');
  await ensureEditor();
  await loadIntoEditor(n, false);
  currentId = n.id; // set last, so a save during loading cannot write the old text into this note
  raisedId = null;
  editor.getWin().scrollTo(0, 0);
  $('edited').textContent = '수정 ' + formatDate(n.updated);
  closeFind();
  const q = $('search').value.trim();
  if (fromSearch && q) openFind(q);
  await render();
}

// On a wide screen the to-do page and the vault open beside the list, as a note does; on a phone
// they cover the list, again as a note does there.
const wideScreen = () => matchMedia('(min-width: 721px)').matches;
function showPage(dialog) {
  if (wideScreen()) {
    dialog.show();
    return;
  }
  dialog.showModal();
  // showModal puts focus on the first button, usually ←, which then wears a focus ring; the page
  // itself takes focus instead. Fields a page focuses on purpose do so after this.
  const active = document.activeElement;
  if (active && active.tagName === 'BUTTON' && dialog.contains(active)) {
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  }
}

// Opening a note or another page from the list replaces the page that is open and takes over its
// place in the history, so the back button never steps through pages already left.
function leavePages() {
  const todo = $('todo').open;
  const vault = $('vault').open;
  if (!todo && !vault) return false;
  if (todo) {
    $('todo').dataset.leaving = '1';
    $('todo').close();
  }
  if (vault) closeVault();
  history.replaceState({ note: true }, '');
  return true;
}

async function openNote(id) {
  leavePages();
  if (id === currentId) {
    const q = $('search').value.trim();
    if (q) openFind(q);
    return;
  }
  await flushEditor();
  await discardIfBlank();
  const n = await getNote(id);
  if (n) await showNote(n, true);
}

async function createNote() {
  leavePages();
  await flushEditor();
  await discardIfBlank();
  const n = makeNote('');
  await updateNote(n.id, () => n);
  putOnTop(n.id);
  await showNote(n, false);
  $('note-title').focus();
}

async function closeEditor() {
  await flushEditor();
  await discardIfBlank();
  hideEditor();
  await render();
}

// Deleting a note moves it to the trash; only the trash removes it for good.
async function deleteCurrent() {
  await flushEditor();
  const id = currentId;
  hideEditor();
  const n = await getNote(id);
  if (n && !n.sha && !hasContent(n)) {
    await removeNote(id); // a blank note that was never saved is not worth keeping
  } else if (n) {
    await setTrashed(id, true);
    toast('휴지통으로 옮겼어요.');
  }
  if (history.state && history.state.note) history.back();
  await render();
  scheduleSync(500);
}

// Like a favorite, moving to and from the trash is not an edit, so the date stays.
const setTrashed = (id, trashed) => updateNote(id, n => {
  if (!n) return;
  n.trashed = trashed ? new Date().toISOString() : '';
  n.rev += 1;
  n.dirty = true;
  return n;
});

async function purgeNote(id) {
  const n = await getNote(id);
  if (n && n.sha) await updateNote(id, x => { x.deleted = true; return x; });
  else if (n) await removeNote(id);
}

const trashedNotes = async () => (await getAll())
  .filter(n => n.trashed && !n.deleted)
  .sort((a, b) => b.trashed.localeCompare(a.trashed));

async function renderTrash() {
  const notes = await trashedNotes();
  $('trash-title').textContent = notes.length ? `휴지통 (${notes.length})` : '휴지통';
  $('trash-list').replaceChildren(...notes.map(n => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = titleOf(n);
    const sub = document.createElement('span');
    const lines = n.text.split('\n').filter(l => l.trim());
    sub.textContent = `${formatDate(n.trashed)}에 삭제  ${((n.title || '').trim() ? lines : lines.slice(1)).join(' ').slice(0, 60)}`;
    info.append(title, sub);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = '복구';
    restore.onclick = async () => {
      await setTrashed(n.id, false);
      putOnTop(n.id);
      toast(`'${titleOf(n).slice(0, 20)}' 노트를 복구했어요.`);
      await render();
      scheduleSync(500);
    };
    const purge = document.createElement('button');
    purge.type = 'button';
    purge.className = 'text danger';
    purge.textContent = '삭제';
    purge.onclick = () => askPurge([n.id], `'${titleOf(n).slice(0, 40)}' 노트를 완전히 삭제할까요?`);
    li.append(info, restore, purge);
    return li;
  }));
  $('trash-empty').hidden = notes.length > 0;
  $('trash-clear').hidden = notes.length === 0;
}

let purgeIds = [];
function askPurge(ids, text) {
  purgeIds = ids;
  $('purge-text').textContent = text;
  $('purge').showModal();
}

async function confirmPurge() {
  $('purge').close();
  for (const id of purgeIds) await purgeNote(id);
  toast(purgeIds.length > 1 ? `노트 ${purgeIds.length}개를 완전히 삭제했어요.` : '노트를 완전히 삭제했어요.');
  purgeIds = [];
  await render();
  scheduleSync(500);
}

async function openTrash() {
  await renderTrash();
  history.pushState({ trash: true }, '');
  $('trash').showModal();
}

// Reloads the open note when a sync changed it underneath the editor.
async function refreshEditor() {
  if (!currentId || !editor) return;
  const n = await getNote(currentId);
  if (!n || n.deleted || n.trashed) {
    hideEditor();
    toast(n && n.trashed ? '열어 둔 노트가 다른 기기에서 휴지통으로 옮겨졌어요.' : '열어 둔 노트가 다른 기기에서 삭제됐어요.');
  } else {
    showFavorite(n);
    if ((n.body === loadedBody && (n.title || '') === savedTitle)
      || toStoredHtml(editor.getContent()) !== savedValue
      || $('note-title').value !== savedTitle) return;
    await loadIntoEditor(n, true);
    $('edited').textContent = '수정 ' + formatDate(n.updated);
    if (!$('find-bar').hidden) runFind(false);
  }
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  // A full-screen page sits above everything else, so the message is shown inside it.
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---------- Find inside a note ----------

let hits = [];
let hitIndex = 0;
let findTimer = null;

function scheduleFind() {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(false), 250);
}

// Text is matched across inline formatting, so a word that is half bold is still found.
function collectRanges(q) {
  const doc = editor.getDoc();
  const walker = doc.createTreeWalker(editor.getBody(), NodeFilter.SHOW_TEXT);
  const pieces = [];
  let text = '';
  let lastBlock = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let block = node.parentElement;
    while (block && !BLOCKS.has(block.tagName) && block.tagName !== 'TD' && block.tagName !== 'TH') block = block.parentElement;
    if (lastBlock && block !== lastBlock) text += '\n';
    lastBlock = block;
    pieces.push({ node, start: text.length });
    text += node.data;
  }
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return [];
  const locate = at => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (pieces[mid].start <= at) lo = mid; else hi = mid - 1;
    }
    return pieces[lo];
  };
  const ranges = [];
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    const first = locate(at);
    const last = locate(at + q.length - 1);
    const range = doc.createRange();
    range.setStart(first.node, at - first.start);
    range.setEnd(last.node, at + q.length - last.start);
    ranges.push(range);
  }
  return ranges;
}

function paintHits() {
  const win = editor.getWin();
  if (win.CSS && win.CSS.highlights && win.Highlight) {
    win.CSS.highlights.set('note-hit', new win.Highlight(...hits));
    if (hits[hitIndex]) win.CSS.highlights.set('note-current', new win.Highlight(hits[hitIndex]));
    else win.CSS.highlights.delete('note-current');
  } else if (hits[hitIndex]) {
    editor.selection.setRng(hits[hitIndex]); // older browsers: select the match instead
  }
  $('find-count').textContent = hits.length ? `${hitIndex + 1} / ${hits.length}` : '0 / 0';
  if (hits[hitIndex]) {
    const rect = hits[hitIndex].getBoundingClientRect();
    if (rect.top < 60 || rect.bottom > win.innerHeight - 60) {
      win.scrollBy(0, rect.top - win.innerHeight / 3);
    }
  }
}

function runFind(jump) {
  const q = $('find-input').value.trim().toLowerCase();
  const previous = hitIndex;
  hits = q && editor ? collectRanges(q) : [];
  hitIndex = jump ? 0 : Math.min(previous, Math.max(0, hits.length - 1));
  paintHits();
}

function stepFind(delta) {
  if (!hits.length) return;
  hitIndex = (hitIndex + delta + hits.length) % hits.length;
  paintHits();
}

function openFind(q) {
  $('find-bar').hidden = false;
  if (q !== undefined) $('find-input').value = q;
  runFind(true);
}

function closeFind() {
  clearTimeout(findTimer);
  $('find-bar').hidden = true;
  $('find-input').value = '';
  $('find-count').textContent = '';
  hits = [];
  hitIndex = 0;
  if (editor) {
    const win = editor.getWin();
    if (win.CSS && win.CSS.highlights) win.CSS.highlights.clear();
  }
}

// ---------- GitHub sync ----------

const loadConfig = () => {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch { return null; }
};
const apiBase = () => localStorage.getItem('notes.apiBase') || 'https://api.github.com';

class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function api(cfg, path, options = {}) {
  const res = await fetch(apiBase() + path, {
    ...options,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let message = '';
    try { message = (await res.json()).message || ''; } catch { /* no JSON body */ }
    let retryAfter = 0;
    if (res.headers.get('retry-after')) retryAfter = Number(res.headers.get('retry-after'));
    else if (/rate limit/i.test(message)) retryAfter = 300;
    throw new ApiError(res.status, message, retryAfter);
  }
  return res.status === 204 ? null : res.json();
}

async function readRepo(cfg) {
  const repo = await api(cfg, `/repos/${cfg.repo}`);
  if (!repo.private) throw new ApiError(0, 'public-repo');
  return repo;
}

let syncing = false;
let syncAgain = false;
let syncTimer = null;
let backoffUntil = 0;
let vanishChoice = null; // what the user decided for notes missing from the repository

function setStatus(text, isError) {
  const s = $('sync-status');
  s.textContent = text;
  s.classList.toggle('error', Boolean(isError));
}

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  const cfg = loadConfig();
  if (!cfg) { setStatus('이 기기에만 저장'); return; }
  if (!navigator.onLine) { setStatus('오프라인'); return; }
  if (Date.now() < backoffUntil || $('vanish').open) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setStatus('동기화 중…');
  try {
    await flushEditor();
    const more = await syncOnce(cfg);
    setStatus(more ? '동기화 중…' : '동기화됨 ' + formatDate(new Date().toISOString()));
    if (more) scheduleSync(60000);
  } catch (e) {
    if (e instanceof ApiError && e.retryAfter) {
      backoffUntil = Date.now() + e.retryAfter * 1000;
      setStatus('요청이 많아 잠시 후 이어서 동기화');
      setTimeout(syncNow, e.retryAfter * 1000 + 1000);
    } else if (e instanceof ApiError && e.message === 'public-repo') {
      setStatus('공개 저장소라 동기화 중단', true);
    } else if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) {
      setStatus('저장소나 토큰을 확인하세요', true);
    } else if (e instanceof ApiError && e.status === 409) {
      syncAgain = true; // someone else committed first; the next cycle sees the new state
    } else if (e && e.message === 'vanished') {
      setStatus('확인이 필요해요', true);
    } else {
      setStatus('동기화 실패, 다시 시도합니다', true);
    }
  } finally {
    syncing = false;
    await refreshEditor();
    await render();
    await vaultAfterSync();
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(1000);
    }
  }
}

async function readTree(cfg, repo) {
  const notes = new Map();
  const images = new Map();
  const vault = new Map();
  let todos = null;
  let order = null;
  let tree;
  try {
    tree = await api(cfg, `/repos/${cfg.repo}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
  } catch (e) {
    // Only a repository with no commits yet may count as empty; any other failure must stop the sync.
    if (e.status === 409 || (e.status === 404 && repo.size === 0)) return { notes, images, vault, todos, order };
    throw e;
  }
  if (tree.truncated) throw new Error('truncated');
  for (const item of tree.tree) {
    if (item.type !== 'blob') continue;
    if (item.path === TODO_FILE) todos = item.sha;
    if (item.path === ORDER_FILE) order = item.sha;
    const note = item.path.match(/^notes\/([\w-]+)\.html$/);
    const image = item.path.match(/^images\/([0-9a-f]+\.(?:jpg|png|gif))$/);
    const secret = item.path.match(/^vault\/([\w-]+)\.json$/);
    if (note) notes.set(note[1], item.sha);
    else if (image) images.set(image[1], item.sha);
    else if (secret) vault.set(secret[1], item.sha);
  }
  return { notes, images, vault, todos, order };
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };

async function syncImages(cfg, remote) {
  const locals = await getAllImages();
  const known = new Set(locals.map(i => i.name));
  let uploads = 0;
  const missing = [...remote].filter(([name]) => !known.has(name));
  for (const [i, [name, sha]] of missing.entries()) {
    if (missing.length > 5) setStatus(`사진 받는 중 ${i}/${missing.length}`);
    const blob = await api(cfg, `/repos/${cfg.repo}/git/blobs/${sha}`);
    await putImage({ name, blob: new Blob([base64ToBytes(blob.content)], { type: MIME[name.split('.').pop()] }), uploaded: true });
  }
  for (const image of locals) {
    if (remote.has(image.name)) {
      if (!image.uploaded) await putImage({ ...image, uploaded: true });
    } else {
      // Also covers a repository that was replaced: anything it lacks is sent again.
      if (uploads >= MAX_UPLOADS_PER_CYCLE) return uploads;
      await api(cfg, `/repos/${cfg.repo}/contents/images/${image.name}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `이미지 ${image.name.slice(0, 8)}`,
          content: bytesToBase64(new Uint8Array(await image.blob.arrayBuffer())),
        }),
      });
      await putImage({ ...image, uploaded: true });
      uploads += 1;
    }
  }
  return uploads;
}

async function download(cfg, id, sha) {
  const blob = await api(cfg, `/repos/${cfg.repo}/git/blobs/${sha}`);
  const parsed = fromFile(fromBase64(blob.content));
  await updateNote(id, n => {
    if (n && n.dirty && !n.deleted) return; // edited meanwhile; the next cycle handles it
    return { id, ...parsed, rev: n ? n.rev + 1 : 1, sha, dirty: false, deleted: false };
  });
}

async function upload(cfg, note) {
  const res = await api(cfg, `/repos/${cfg.repo}/contents/notes/${note.id}.html`, {
    method: 'PUT',
    body: JSON.stringify({
      message: titleOf(note).slice(0, 72),
      content: toBase64(toFile(note)),
      ...(note.sha ? { sha: note.sha } : {}),
    }),
  });
  await updateNote(note.id, n => {
    if (!n) return;
    n.sha = res.content.sha;
    n.dirty = n.rev !== note.rev;
    return n;
  });
}

// A different repository id means the repository was recreated or swapped: nothing there
// says anything about what should be deleted here, so everything local is offered to it.
async function adoptRepository(repo) {
  const last = localStorage.getItem(REPO_ID_KEY);
  if (last && last !== String(repo.id)) {
    for (const note of await getAll()) {
      if (note.deleted) await removeNote(note.id);
      else await updateNote(note.id, n => { n.sha = null; n.dirty = true; return n; });
    }
    await resetVaultSync();
    resetTodoSync();
    resetOrderSync();
  }
  localStorage.setItem(REPO_ID_KEY, String(repo.id));
}

function askAboutVanished(ids) {
  $('vanish-count').textContent = ids.length;
  $('vanish-delete').onclick = () => { vanishChoice = 'delete'; $('vanish').close(); syncNow(); };
  $('vanish-restore').onclick = async () => {
    for (const id of ids) await updateNote(id, n => { n.sha = null; n.dirty = true; return n; });
    $('vanish').close();
    syncNow();
  };
  $('vanish').showModal();
}

// Returns true when uploads remain for a later cycle.
async function syncOnce(cfg) {
  const repo = await readRepo(cfg);
  await adoptRepository(repo);
  const remoteTree = await readTree(cfg, repo);
  const remote = remoteTree.notes;
  const locals = await getAll();

  // Several notes disappearing at once is more likely an accident than a decision: ask first.
  const vanished = locals.filter(n => n.sha && !n.dirty && !n.deleted && !remote.has(n.id)).map(n => n.id);
  const tracked = locals.filter(n => n.sha && !n.deleted).length;
  const suspicious = vanished.length > 0 && (remote.size === 0 || (vanished.length >= 3 && vanished.length >= tracked * 0.3));
  if (suspicious && vanishChoice !== 'delete') {
    askAboutVanished(vanished);
    throw new Error('vanished');
  }
  vanishChoice = null;

  // New notes come down first, and appear in the list as they arrive: on a new device the first
  // sync can take minutes, and an empty list looks broken.
  const known = new Set(locals.map(n => n.id));
  const fresh = [...remote.keys()].filter(id => !known.has(id));
  let drawn = Date.now();
  for (const [i, id] of fresh.entries()) {
    if (fresh.length > 5) setStatus(`노트 받는 중 ${i}/${fresh.length}`);
    await download(cfg, id, remote.get(id));
    if (Date.now() - drawn > 1000) {
      drawn = Date.now();
      await render();
    }
  }

  // Images are uploaded before notes, so a note never reaches another device before its pictures.
  let uploads = await syncImages(cfg, remoteTree.images);
  let more = uploads >= MAX_UPLOADS_PER_CYCLE;

  const vaultResult = await syncVault(cfg, remoteTree.vault, Math.max(0, MAX_UPLOADS_PER_CYCLE - uploads));
  uploads += vaultResult.writes;
  more = more || vaultResult.more;

  uploads += await syncTodos(cfg, remoteTree.todos);
  uploads += await syncOrder(cfg, remoteTree.order);

  for (const note of locals) {
    const remoteSha = remote.get(note.id);
    if (!note.sha && !hasContent(note)) continue; // a blank note that was never saved

    if (note.deleted) {
      if (!remoteSha) await removeNote(note.id);
      else if (remoteSha === note.sha) {
        await api(cfg, `/repos/${cfg.repo}/contents/notes/${note.id}.html`, {
          method: 'DELETE',
          body: JSON.stringify({ message: `삭제: ${titleOf(note).slice(0, 60)}`, sha: remoteSha }),
        });
        await removeNote(note.id);
      } else {
        // Edited on another device after being deleted here: the edit wins.
        await download(cfg, note.id, remoteSha);
        toast('삭제한 노트가 다른 기기에서 수정되어 되살렸어요.');
      }
      continue;
    }

    if (remoteSha && remoteSha !== note.sha) {
      if (note.dirty) {
        const theirs = fromFile(fromBase64((await api(cfg, `/repos/${cfg.repo}/git/blobs/${remoteSha}`)).content));
        if (theirs.body !== note.body.trim() || theirs.title !== (note.title || '')) {
          // Changed on both sides: keep this device's text as a separate copy.
          const copy = makeNote(`${note.body}<p>(충돌 사본: 다른 기기의 수정과 겹쳐 따로 보관했어요)</p>`, note.created, note.updated, note.title || '', Boolean(note.favorite));
          await updateNote(copy.id, () => copy);
          if (currentId === note.id) { currentId = copy.id; savedValue = toStoredHtml(editor.getContent()); loadedBody = ''; }
          toast('다른 기기와 수정이 겹쳐 사본을 만들었어요.');
          syncAgain = true;
        }
        await updateNote(note.id, n => { n.dirty = false; return n; });
      }
      await download(cfg, note.id, remoteSha);
    } else if (!remoteSha && note.sha && !note.dirty) {
      await removeNote(note.id); // deleted on another device
    } else if (note.dirty) {
      if (uploads >= MAX_UPLOADS_PER_CYCLE) { more = true; continue; }
      // A note deleted elsewhere but edited here is uploaded again as new.
      await upload(cfg, remoteSha ? note : { ...note, sha: null });
      uploads += 1;
    }
  }
  return more;
}

// ---------- Import and export ----------

// Evernote identifies pictures by MD5, which browsers do not provide.
function md5(bytes) {
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const padded = new Uint8Array(((bytes.length + 8 >>> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bytes.length / 2 ** 29), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < padded.length; off += 64) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + K[i] + view.getUint32(off + g * 4, true)) >>> 0;
      const s = shifts[(Math.floor(i / 16) * 4) + (i % 4)];
      a = d; d = c; c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return [...new Uint8Array(out.buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function enexDate(value) {
  const m = (value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

// Turns Evernote's markup into the HTML notes use. resources maps MD5 to stored image names.
function enmlToHtml(enml, resources) {
  // The HTML parser ignores "/>" on tags like en-media, which would swallow the text after them.
  const closed = enml.replace(/<([a-z][\w-]*)\b([^<>]*?)\/>/gi, (all, tag, attrs) =>
    /^(br|hr|img)$/i.test(tag) ? all : `<${tag}${attrs}></${tag}>`);
  const doc = parseHtml(closed);
  let skipped = 0;
  doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta,base,en-crypt').forEach(el => el.remove());
  doc.querySelectorAll('en-todo').forEach(el => {
    const box = doc.createElement('input');
    box.setAttribute('type', 'checkbox');
    if (el.getAttribute('checked') === 'true') box.setAttribute('checked', 'checked');
    el.replaceWith(box);
  });
  doc.querySelectorAll('en-media').forEach(el => {
    const res = resources.get(el.getAttribute('hash'));
    if (res && res.name) {
      const img = doc.createElement('img');
      img.setAttribute('src', `../images/${res.name}`);
      img.setAttribute('alt', '');
      el.replaceWith(img);
    } else {
      skipped += 1;
      el.replaceWith(doc.createTextNode(`[첨부 파일 생략${res && res.fileName ? `: ${res.fileName}` : ''}]`));
    }
  });
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || (['href', 'src'].includes(name) && /^\s*(javascript|vbscript|data):/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  const root = doc.querySelector('en-note') || doc.body;
  return { html: root.innerHTML.trim(), skipped };
}

// The same note always gets the same id, so importing a file twice adds nothing.
async function importId(prefix, content) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return prefix + [...new Uint8Array(hash)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function parseEnex(text) {
  const xml = new DOMParser().parseFromString(text, 'text/xml');
  if (xml.querySelector('parsererror')) throw new Error('enex');
  const notes = [];
  let skipped = 0;
  for (const el of xml.querySelectorAll('note')) {
    const children = name => [...el.children].filter(c => c.tagName === name);
    const child = name => children(name)[0];

    const resources = new Map();
    for (const res of children('resource')) {
      const data = res.querySelector('data');
      if (!data) continue;
      const bytes = base64ToBytes(data.textContent);
      const mime = res.querySelector('mime') ? res.querySelector('mime').textContent : '';
      const fileNode = res.querySelector('file-name');
      const entry = { fileName: fileNode ? fileNode.textContent : '' };
      if (mime.startsWith('image/')) {
        try { entry.name = (await storeImage(new Blob([bytes], { type: mime }))).name; } catch { /* unreadable format */ }
      }
      resources.set(md5(bytes), entry);
    }

    const title = child('title') ? child('title').textContent.trim() : '';
    const converted = enmlToHtml(child('content') ? child('content').textContent : '', resources);
    skipped += converted.skipped;
    const tags = children('tag').map(c => '#' + c.textContent.trim().replace(/\s+/g, '_')).join(' ');
    const body = converted.html + (tags ? `<p>${escapeHtml(tags)}</p>` : '');
    const created = enexDate(child('created') && child('created').textContent);
    const updated = enexDate(child('updated') && child('updated').textContent) || created;
    // Hashes the title with the body so notes imported before title fields existed keep their id.
    const idSource = (title ? `<h1>${escapeHtml(title)}</h1>` : '') + body;
    notes.push({ ...makeNote(body, created, updated, title), id: await importId('en-', `${created}\n${idSource}`) });
  }
  return { notes, skipped };
}

async function parseBackup(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.notes)) throw new Error('json');
  for (const image of data.images || []) {
    if (/^[0-9a-f]+\.(jpg|png|gif)$/.test(image.name) && !(await getImage(image.name))) {
      const blob = new Blob([base64ToBytes(image.data)], { type: MIME[image.name.split('.').pop()] });
      await putImage({ name: image.name, blob, uploaded: false });
    }
  }
  const notes = data.notes
    .filter(n => typeof n.body === 'string' && /^[\w-]+$/.test(n.id))
    .map(n => ({ ...makeNote(n.body, n.created, n.updated, typeof n.title === 'string' ? n.title : '', n.favorite === true), id: n.id }));
  return { notes, skipped: 0, notice: await importVaultRecords(data.vault) };
}

async function importFiles(files) {
  const msg = $('io-msg');
  msg.textContent = '가져오는 중…';
  let added = 0;
  let existing = 0;
  let skipped = 0;
  let notice = '';
  try {
    for (const file of files) {
      const text = await file.text();
      const parsed = file.name.toLowerCase().endsWith('.json') ? await parseBackup(text) : await parseEnex(text);
      skipped += parsed.skipped;
      notice += parsed.notice || '';
      for (const note of parsed.notes) {
        const stored = await updateNote(note.id, n => (n ? undefined : note));
        if (stored) added += 1; else existing += 1;
      }
    }
    msg.textContent = `${added}개 가져옴` + (existing ? `, 이미 있는 ${existing}개 건너뜀` : '') + (skipped ? `. 이미지가 아닌 첨부 파일 ${skipped}개는 옮겨지지 않았어요.` : '.') + notice;
  } catch {
    msg.textContent = '파일을 읽지 못했어요. 지금까지 ' + added + '개를 가져왔어요.';
  }
  await render();
  scheduleSync(500);
}

async function exportAll() {
  await flushEditor();
  const notes = (await getAll())
    .filter(n => !n.deleted && !n.trashed && hasContent(n))
    .map(({ id, title, favorite, body, created, updated }) => ({ id, title: title || '', favorite: Boolean(favorite), body, created, updated }));
  const images = [];
  for (const image of await getAllImages()) {
    images.push({ name: image.name, data: bytesToBase64(new Uint8Array(await image.blob.arrayBuffer())) });
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify({ notes, images, vault: await exportVaultRecords() })], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `노트-백업-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('io-msg').textContent = `노트 ${notes.length}개와 이미지 ${images.length}개를 내보냈어요.`;
}

// ---------- Settings ----------

function openSettings() {
  const cfg = loadConfig();
  $('cfg-repo').value = cfg ? cfg.repo : '';
  $('cfg-token').value = cfg ? cfg.token : '';
  $('cfg-msg').textContent = '';
  $('io-msg').textContent = '';
  if (window.caches) caches.keys().then(keys => { $('app-version').textContent = `앱 버전: ${keys.join(', ')}`; }).catch(() => {});
  $('settings').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const cfg = { repo: $('cfg-repo').value.trim(), token: $('cfg-token').value.trim() };
  const msg = $('cfg-msg');
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo) || !cfg.token) {
    msg.textContent = '저장소는 아이디/이름 형식으로, 토큰과 함께 입력하세요.';
    return;
  }
  msg.textContent = '확인 중…';
  try {
    await readRepo(cfg);
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    backoffUntil = 0;
    msg.textContent = '연결됐어요.';
    syncNow();
  } catch (e) {
    if (e.message === 'public-repo') msg.textContent = '공개 저장소에는 연결하지 않아요. 비공개로 바꾼 뒤 다시 시도하세요.';
    else if (e.status === 401) msg.textContent = '토큰이 올바르지 않아요.';
    else if (e.status === 403 || e.status === 404) msg.textContent = '저장소를 찾을 수 없거나 토큰에 권한이 없어요.';
    else msg.textContent = '연결하지 못했어요. 인터넷 연결을 확인하세요.';
  }
}

function clearSettings() {
  localStorage.removeItem(CFG_KEY);
  $('cfg-repo').value = '';
  $('cfg-token').value = '';
  $('cfg-msg').textContent = '연결을 해제했어요. 노트는 이 기기에 남아 있어요.';
  setStatus('이 기기에만 저장');
}

// ---------- Wiring ----------

$('new-note').onclick = createNote;
$('favorite').onclick = () => { if (currentId) toggleFavorite(currentId); };
$('note-title').addEventListener('input', onEdit);
$('note-title').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); editor.focus(); }
});
$('back').onclick = () => history.back();
// Password managers ignore autocomplete="off" and can type a saved login into a search box, which
// empties the list. They skip read-only fields, so these are writable only while in use.
for (const id of ['search', 'find-input', 'vault-search']) {
  const box = $(id);
  const unlock = () => { box.readOnly = false; };
  box.addEventListener('pointerdown', unlock);
  box.addEventListener('focus', unlock);
  box.addEventListener('blur', () => { box.readOnly = true; });
}
$('search').addEventListener('input', render);
// Each search box has its own ✕, shown while it holds text, which the browser's own hides on blur.
for (const button of document.querySelectorAll('[data-clear]')) {
  button.onclick = () => {
    const box = $(button.dataset.clear);
    box.value = '';
    box.dispatchEvent(new Event('input'));
  };
}
$('order-edit').onclick = toggleOrderEditing;
$('move-to-folder').onclick = openFolderMove;
$('folder-create').addEventListener('submit', createFolder);
$('folder-move-close').onclick = () => $('folder-move').close();
$('folder-save').onclick = saveFolderName;
$('folder-name').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveFolderName(); } });
$('folder-delete').onclick = deleteFolder;
$('folder-favorite').onclick = () => {
  $('folder-edit').close();
  toggleFolderFavorite(editingFolderId);
};
$('folder-edit-close').onclick = () => $('folder-edit').close();
// Moving a note to the trash sits in a menu, away from where the thumb rests.
function toggleNoteMenu(open) {
  $('note-menu').hidden = !open;
  $('note-more').setAttribute('aria-expanded', String(open));
}
$('note-more').onclick = () => toggleNoteMenu($('note-menu').hidden);
document.addEventListener('pointerdown', e => {
  if (!$('note-menu').hidden && !e.target.closest('#note-menu, #note-more')) toggleNoteMenu(false);
});
window.addEventListener('blur', () => toggleNoteMenu(false)); // a tap into the editor's frame
$('delete').onclick = () => { toggleNoteMenu(false); $('confirm').showModal(); };
$('confirm-no').onclick = () => $('confirm').close();
$('confirm-yes').onclick = () => { $('confirm').close(); deleteCurrent(); };
$('find-open').onclick = () => {
  if ($('find-bar').hidden) openFind($('search').value.trim());
  $('find-input').focus();
};
$('find-close').onclick = closeFind;
$('find-prev').onclick = () => stepFind(-1);
$('find-next').onclick = () => stepFind(1);
$('find-input').addEventListener('input', () => runFind(true));
$('find-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeFind();
});
$('image-file').onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) insertImages(files); };
$('sync-now').onclick = syncNow;

// The list's width is dragged by its right border and remembered on this device.
const SIDE_WIDTH_KEY = 'notes.sideWidth';
const DEFAULT_SIDE_WIDTH = 320;
function setSideWidth(width, save) {
  const clamped = Math.round(Math.max(220, Math.min(width, window.innerWidth - 360)));
  document.documentElement.style.setProperty('--side-width', `${clamped}px`);
  $('resizer').setAttribute('aria-valuenow', clamped);
  if (save) localStorage.setItem(SIDE_WIDTH_KEY, String(clamped));
}
setSideWidth(Number(localStorage.getItem(SIDE_WIDTH_KEY)) || DEFAULT_SIDE_WIDTH, false);
window.addEventListener('resize', () => setSideWidth(Number(localStorage.getItem(SIDE_WIDTH_KEY)) || DEFAULT_SIDE_WIDTH, false));
$('resizer').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const handle = e.currentTarget;
  const startX = e.clientX, startWidth = $('side').getBoundingClientRect().width;
  handle.setPointerCapture(e.pointerId);
  handle.classList.add('dragging');
  document.body.classList.add('resizing');
  const move = ev => setSideWidth(startWidth + ev.clientX - startX, false);
  const end = ev => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    setSideWidth(startWidth + ev.clientX - startX, true);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  e.preventDefault();
});
$('resizer').addEventListener('dblclick', () => setSideWidth(DEFAULT_SIDE_WIDTH, true));
$('resizer').addEventListener('keydown', e => {
  const step = e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0;
  if (step) { e.preventDefault(); setSideWidth($('side').getBoundingClientRect().width + step, true); }
});
$('open-settings').onclick = openSettings;
$('settings-close').onclick = () => $('settings').close();
$('settings-form').addEventListener('submit', saveSettings);
$('cfg-clear').onclick = clearSettings;
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) importFiles(files); };
$('export').onclick = exportAll;
$('open-trash').onclick = openTrash;
$('trash-close').onclick = () => $('trash').close();
$('trash').addEventListener('close', () => { if (history.state && history.state.trash) history.back(); });
$('trash-clear').onclick = async () => {
  const ids = (await trashedNotes()).map(n => n.id);
  if (ids.length) askPurge(ids, `휴지통의 노트 ${ids.length}개를 모두 완전히 삭제할까요?`);
};
$('purge-no').onclick = () => $('purge').close();
$('purge-yes').onclick = confirmPurge;

window.addEventListener('popstate', () => {
  if ($('purge').open) $('purge').close();
  if ($('trash').open) { $('trash').close(); return; }
  if ($('todo').open) { todoBack(); return; }
  if ($('vault').open) { vaultBack(); return; }
  if (currentId) closeEditor();
});
window.addEventListener('online', syncNow);
window.addEventListener('offline', () => setStatus('오프라인'));
document.addEventListener('visibilitychange', () => {
  // Phones may kill a hidden app at any moment, so save and sync right away.
  if (document.visibilityState === 'hidden') flushEditor().then(syncNow);
  else syncNow();
});
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let updateSeen = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || updateSeen) return;
    updateSeen = true;
    // Never reload under someone who is editing or inside the vault.
    if (!currentId && !$('vault').open && !$('todo').open) {
      sessionStorage.setItem(STAY_ON_LIST_KEY, '1');
      location.reload();
    }
    else toast('새 버전이 준비됐어요. 앱을 다시 열면 적용돼요.');
  });
  navigator.serviceWorker.register('sw.js');
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

render();
syncNow();
