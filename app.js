'use strict';

const $ = id => document.getElementById(id);
const CFG_KEY = 'notes.config';
const REPO_ID_KEY = 'notes.repoId';
// Site names and addresses of vault entries, unencrypted and on this device only, so the main
// search can find them while the vault is locked. IDs, passwords and memos are never in it.
const VAULT_INDEX_KEY = 'notes.vaultIndex';
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
  return { id: newId(), title, favorite, body, text: htmlToText(body), created: created || now, updated: updated || now, rev: 1, sha: null, dirty: true, deleted: false };
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
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="created" content="${n.created}">\n<meta name="updated" content="${n.updated}">\n<meta name="note-title" content="${escapeHtml(n.title || '')}">\n<meta name="favorite" content="${Boolean(n.favorite)}">\n<title>${escapeHtml(titleOf(n))}</title>\n</head>\n<body>\n${n.body}\n</body>\n</html>\n`;
}

function fromFile(text) {
  const doc = parseHtml(text);
  const meta = name => {
    const el = doc.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : null;
  };
  const now = new Date().toISOString();
  const body = doc.body.innerHTML.trim();
  return { title: meta('note-title') || '', favorite: meta('favorite') === 'true', created: meta('created') || now, updated: meta('updated') || now, body, text: htmlToText(body) };
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
        table { max-width: 100%; }
        input[type=checkbox] { width: 16px; height: 16px; margin-right: 4px; vertical-align: -2px; }
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
      if (img.hasAttribute('data-note-image') || IMAGE_PATH.test(src)) continue;
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

function readVaultIndex() {
  try {
    const list = JSON.parse(localStorage.getItem(VAULT_INDEX_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function render() {
  const all = (await getAll()).filter(n => !n.deleted);
  // Blank notes stay hidden from the list unless they are the one being edited.
  const visible = all.filter(n => hasContent(n) || n.id === currentId);
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
    .sort((a, b) => b.updated.localeCompare(a.updated));

  const favorites = shown.filter(n => n.favorite);
  const others = shown.filter(n => !n.favorite);
  const label = text => {
    const li = document.createElement('li');
    li.className = 'label';
    li.textContent = text;
    return li;
  };
  const row = n => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = n.id === currentId ? 'note on' : 'note';
    const title = document.createElement('strong');
    title.textContent = titleOf(n);
    const sub = document.createElement('span');
    appendSnippet(sub, n, q);
    b.append(title, sub);
    b.onclick = () => openNote(n.id);
    const star = document.createElement('button');
    star.type = 'button';
    star.className = n.favorite ? 'star on' : 'star';
    star.textContent = n.favorite ? '★' : '☆';
    star.setAttribute('aria-label', n.favorite ? '즐겨찾기 해제' : '즐겨찾기');
    star.setAttribute('aria-pressed', String(Boolean(n.favorite)));
    star.onclick = () => toggleFavorite(n.id);
    li.append(b, star);
    return li;
  };
  const vaultHits = q && !activeTag ? readVaultIndex().filter(e => `${e.site}\n${e.url}`.toLowerCase().includes(q)) : [];
  const vaultRow = e => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const title = document.createElement('strong');
    title.textContent = `🔒 ${e.site.trim() || e.url.trim()}`;
    const sub = document.createElement('span');
    sub.textContent = e.site.trim() && e.url.trim() ? e.url.trim() : '금고 항목 · 열려면 잠금 해제';
    b.append(title, sub);
    b.onclick = () => openVaultEntry(e.id);
    li.append(b);
    return li;
  };
  $('list').replaceChildren(
    ...(favorites.length ? [label('즐겨찾기'), ...favorites.map(row)] : []),
    ...(favorites.length && others.length ? [label('노트')] : []),
    ...others.map(row),
    ...(vaultHits.length ? [label('금고'), ...vaultHits.map(vaultRow)] : []),
  );

  const empty = $('empty');
  empty.hidden = shown.length + vaultHits.length > 0;
  empty.textContent = q || activeTag ? '찾는 노트가 없어요.' : '아직 노트가 없어요. ＋ 버튼으로 시작하세요.';
}

function onEdit() {
  if (loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushEditor, 600);
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
  star.textContent = n.favorite ? '★' : '☆';
  star.classList.toggle('on', Boolean(n.favorite));
  star.setAttribute('aria-pressed', String(Boolean(n.favorite)));
}

// Marking a favorite is not an edit, so the note keeps its place and its date.
async function toggleFavorite(id) {
  const note = await updateNote(id, n => {
    if (!n) return;
    n.favorite = !n.favorite;
    n.rev += 1;
    n.dirty = true;
    return n;
  });
  if (note && id === currentId) showFavorite(note);
  await render();
  scheduleSync(1000);
}

function hideEditor() {
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
  editor.getWin().scrollTo(0, 0);
  $('edited').textContent = '수정 ' + formatDate(n.updated);
  closeFind();
  const q = $('search').value.trim();
  if (fromSearch && q) openFind(q);
  await render();
}

async function openNote(id) {
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
  await flushEditor();
  await discardIfBlank();
  const n = makeNote('');
  await updateNote(n.id, () => n);
  await showNote(n, false);
  $('note-title').focus();
}

async function closeEditor() {
  await flushEditor();
  await discardIfBlank();
  hideEditor();
  await render();
}

async function deleteCurrent() {
  const id = currentId;
  clearTimeout(saveTimer);
  hideEditor();
  const n = await getNote(id);
  if (n && n.sha) {
    await updateNote(id, x => { x.deleted = true; return x; });
  } else if (n) {
    await removeNote(id);
  }
  if (history.state && history.state.note) history.back();
  await render();
  scheduleSync(500);
}

// Reloads the open note when a sync changed it underneath the editor.
async function refreshEditor() {
  if (!currentId || !editor) return;
  const n = await getNote(currentId);
  if (!n || n.deleted) {
    hideEditor();
    toast('열어 둔 노트가 다른 기기에서 삭제됐어요.');
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
  let tree;
  try {
    tree = await api(cfg, `/repos/${cfg.repo}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
  } catch (e) {
    // Only a repository with no commits yet may count as empty; any other failure must stop the sync.
    if (e.status === 409 || (e.status === 404 && repo.size === 0)) return { notes, images, vault };
    throw e;
  }
  if (tree.truncated) throw new Error('truncated');
  for (const item of tree.tree) {
    if (item.type !== 'blob') continue;
    const note = item.path.match(/^notes\/([\w-]+)\.html$/);
    const image = item.path.match(/^images\/([0-9a-f]+\.(?:jpg|png|gif))$/);
    const secret = item.path.match(/^vault\/([\w-]+)\.json$/);
    if (note) notes.set(note[1], item.sha);
    else if (image) images.set(image[1], item.sha);
    else if (secret) vault.set(secret[1], item.sha);
  }
  return { notes, images, vault };
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };

async function syncImages(cfg, remote) {
  const locals = await getAllImages();
  const known = new Set(locals.map(i => i.name));
  let uploads = 0;
  for (const [name, sha] of remote) {
    if (known.has(name)) continue;
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

  // Images go first so a note never reaches another device before its pictures.
  let uploads = await syncImages(cfg, remoteTree.images);
  let more = uploads >= MAX_UPLOADS_PER_CYCLE;

  const vaultResult = await syncVault(cfg, remoteTree.vault, Math.max(0, MAX_UPLOADS_PER_CYCLE - uploads));
  uploads += vaultResult.writes;
  more = more || vaultResult.more;

  const known = new Set(locals.map(n => n.id));
  for (const id of remote.keys()) {
    if (!known.has(id)) await download(cfg, id, remote.get(id));
  }

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
    .filter(n => !n.deleted && hasContent(n))
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
$('delete').onclick = () => $('confirm').showModal();
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

window.addEventListener('popstate', () => {
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
    if (!currentId && !$('vault').open) location.reload();
    else toast('새 버전이 준비됐어요. 앱을 다시 열면 적용돼요.');
  });
  navigator.serviceWorker.register('sw.js');
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

render();
syncNow();
