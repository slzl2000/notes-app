'use strict';

// The vault keeps each entry in its own AES-GCM encrypted file under vault/ in the repository.
// A random vault key encrypts the entries; the passphrase (and optionally a fingerprint) only
// encrypts that key. Sync moves ciphertext alone, so it works while the vault is locked.

const VAULT_META = 'meta';
const KDF_ITERATIONS = 600000;
const MIN_KDF_ITERATIONS = 300000;
const MIN_PASSPHRASE = 8;
const IDLE_LOCK_MS = 5 * 60 * 1000;
const LEAVE_GRACE_MS = 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30 * 1000;
const DRAFT_KEY = 'notes.vaultDraft';
const BIO_KEY = 'notes.vaultBio';
const MAX_USERNAME_CHIPS = 12;

const getVaultRecords = () => tx('vault', 'readonly', (s, done) => { s.getAll().onsuccess = e => done(e.target.result); });
const getVaultRecord = id => tx('vault', 'readonly', (s, done) => { s.get(id).onsuccess = e => done(e.target.result); });
const removeVaultRecord = id => tx('vault', 'readwrite', s => { s.delete(id); });
const updateVaultRecord = (id, change) => tx('vault', 'readwrite', (s, done) => {
  s.get(id).onsuccess = e => {
    const next = change(e.target.result);
    if (next) s.put(next);
    done(next);
  };
});

// ---------- Encryption ----------

const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

async function aesEncrypt(key, plainBytes) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

async function aesDecrypt(key, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(box.iv) }, key, base64ToBytes(box.ct));
  return new Uint8Array(plain);
}

async function passphraseKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const importVaultKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function buildMeta(rawKey, passphrase, keyId) {
  const salt = randomBytes(16);
  const wrapped = await aesEncrypt(await passphraseKey(passphrase, salt, KDF_ITERATIONS), rawKey);
  return { v: 1, keyId, kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) }, key: wrapped };
}

async function readMeta() {
  const record = await getVaultRecord(VAULT_META);
  if (!record || record.deleted) return null;
  return JSON.parse(record.data);
}

// Rejects a weakened meta file, which someone with write access to the repository could plant.
async function rawKeyFromPassphrase(meta, passphrase) {
  if (meta.kdf.name !== 'PBKDF2-SHA256' || !(meta.kdf.iterations >= MIN_KDF_ITERATIONS)) throw new Error('weak-meta');
  const kek = await passphraseKey(passphrase, base64ToBytes(meta.kdf.salt), meta.kdf.iterations);
  return aesDecrypt(kek, meta.key);
}

// ---------- Sync (ciphertext only) ----------

async function readRemoteVaultFile(cfg, sha) {
  return fromBase64((await api(cfg, `/repos/${cfg.repo}/git/blobs/${sha}`)).content);
}

async function uploadVaultRecord(cfg, record, sha) {
  const res = await api(cfg, `/repos/${cfg.repo}/contents/vault/${record.id}.json`, {
    method: 'PUT',
    body: JSON.stringify({ message: '금고 갱신', content: toBase64(record.data), ...(sha ? { sha } : {}) }),
  });
  await updateVaultRecord(record.id, r => {
    if (!r) return;
    r.sha = res.content.sha;
    r.dirty = r.rev !== record.rev;
    return r;
  });
}

async function resetVaultSync() {
  for (const record of await getVaultRecords()) {
    if (record.deleted) await removeVaultRecord(record.id);
    else await updateVaultRecord(record.id, r => { r.sha = null; r.dirty = true; return r; });
  }
}

let vaultSyncChanged = false;

async function downloadVaultRecord(cfg, id, sha) {
  const data = await readRemoteVaultFile(cfg, sha);
  await updateVaultRecord(id, r => {
    if (r && r.dirty && !r.deleted && id !== VAULT_META) return; // edited meanwhile; the next cycle handles it
    return { id, data, sha, dirty: false, deleted: false, rev: r ? r.rev + 1 : 1 };
  });
  vaultSyncChanged = true;
}

// Returns how many writes it used; stops at budget and reports the rest through the return value.
async function syncVault(cfg, remote, budget) {
  let locals = await getVaultRecords();
  const tracked = locals.filter(r => r.sha && !r.deleted);
  const vanished = tracked.filter(r => !r.dirty && !remote.has(r.id));
  const meta = locals.find(r => r.id === VAULT_META);
  const metaLost = meta && meta.sha && !remote.has(VAULT_META);

  // Entries disappearing in bulk look like an accident, so restore them instead of deleting.
  if (metaLost || (vanished.length >= 3 && vanished.length >= tracked.length * 0.3)) {
    for (const r of vanished) await updateVaultRecord(r.id, x => { x.sha = null; x.dirty = true; return x; });
    locals = await getVaultRecords();
  }

  const known = new Set(locals.map(r => r.id));
  for (const [id, sha] of remote) {
    if (!known.has(id)) await downloadVaultRecord(cfg, id, sha);
  }

  let writes = 0;
  let more = false;
  for (const record of locals) {
    const remoteSha = remote.get(record.id);
    if (record.deleted) {
      if (!remoteSha) await removeVaultRecord(record.id);
      else if (remoteSha === record.sha) {
        await api(cfg, `/repos/${cfg.repo}/contents/vault/${record.id}.json`, {
          method: 'DELETE',
          body: JSON.stringify({ message: '금고 갱신', sha: remoteSha }),
        });
        await removeVaultRecord(record.id);
        vaultSyncChanged = true;
      } else {
        await downloadVaultRecord(cfg, record.id, remoteSha); // edited elsewhere after deletion: the edit wins
      }
      continue;
    }

    if (remoteSha && remoteSha !== record.sha) {
      if (record.dirty && record.id !== VAULT_META) {
        const theirs = await readRemoteVaultFile(cfg, remoteSha);
        if (theirs !== record.data) {
          // Changed on both sides: keep this device's version as a separate entry.
          const copy = { id: newId(), data: record.data, sha: null, dirty: true, deleted: false, rev: 1 };
          await updateVaultRecord(copy.id, () => copy);
          syncAgain = true;
        }
        await updateVaultRecord(record.id, r => { r.dirty = false; return r; });
      }
      await downloadVaultRecord(cfg, record.id, remoteSha);
    } else if (!remoteSha && record.sha && !record.dirty) {
      await removeVaultRecord(record.id); // deleted on another device
      vaultSyncChanged = true;
    } else if (record.dirty) {
      if (writes >= budget) { more = true; continue; }
      await uploadVaultRecord(cfg, record, remoteSha ? record.sha : null);
      writes += 1;
    }
  }
  return { writes, more };
}

// ---------- Backup (ciphertext only) ----------

async function exportVaultRecords() {
  return (await getVaultRecords()).filter(r => !r.deleted).map(({ id, data }) => ({ id, data }));
}

// Returns a message when the backup could not be restored.
async function importVaultRecords(records) {
  if (!Array.isArray(records) || !records.length) return '';
  const metaRecord = records.find(r => r.id === VAULT_META);
  const localMeta = await readMeta();
  if (localMeta) {
    let backupKeyId = null;
    try { backupKeyId = metaRecord && JSON.parse(metaRecord.data).keyId; } catch { /* unreadable */ }
    if (backupKeyId !== localMeta.keyId) return ' 다른 금고의 백업이라 금고 항목은 가져오지 않았어요.';
  }
  for (const record of records) {
    if (typeof record.data !== 'string' || !/^[\w-]+$/.test(record.id)) continue;
    await updateVaultRecord(record.id, r => (r ? undefined : { id: record.id, data: record.data, sha: null, dirty: true, deleted: false, rev: 1 }));
  }
  return '';
}

// ---------- State ----------

let vaultKey = null;
let vaultEntries = [];
let vaultPatterns = [];
let editingPatternId = null;
let vaultBroken = 0;
let vaultKeyId = null;
let editingId = null;
let formDirty = false;
let idleTimer = null;
let graceTimer = null;
let clipboardTimer = null;
let vaultBusy = false;

const VAULT_PANELS = ['vault-setup', 'vault-unlock', 'vault-list', 'vault-form', 'vault-options', 'vault-patterns'];

function showVaultPanel(id) {
  for (const panel of VAULT_PANELS) $(panel).hidden = panel !== id;
  vaultMessage('');
  // With a fingerprint available, focusing the password box would only open the keyboard behind its prompt.
  const focus = { 'vault-setup': 'vault-new1', 'vault-unlock': $('vault-bio-unlock').hidden ? 'vault-pass' : 'vault-bio-unlock' }[id];
  if (focus) $(focus).focus();
}

function vaultMessage(text, isError) {
  const el = $('vault-msg');
  el.textContent = text;
  el.classList.toggle('danger', Boolean(isError));
}

function clearVaultInputs() {
  for (const input of $('vault').querySelectorAll('input, textarea')) input.value = '';
  $('vault-password').type = 'password';
  $('vault-show').textContent = '보기';
}

function resetIdleTimer() {
  clearTimeout(idleTimer);
  if (vaultKey) idleTimer = setTimeout(lockVault, IDLE_LOCK_MS);
}

// ---------- Open, unlock, lock ----------

async function openVault() {
  if ($('vault').open) return;
  await flushEditor();
  const state = { vault: true, note: Boolean(history.state && history.state.note) };
  if (leavePages()) history.replaceState(state, '');
  else history.pushState(state, '');
  clearVaultInputs();
  showPage($('vault'));
  // Back within a minute of leaving: still unlocked, unless the key was changed on another device.
  if (vaultKey) {
    clearTimeout(graceTimer);
    const meta = await readMeta();
    if (meta && meta.keyId === vaultKeyId) {
      await reloadEntries();
      backToList();
      resetIdleTimer();
      const pending = vaultEntries.find(e => e.id === pendingEntryId);
      pendingEntryId = null;
      if (pending) openForm(pending);
      return;
    }
    lockVault();
  }
  await showLockedPanel();
  // Only here, not after locking: the lock button must not bring the prompt straight back.
  if (!$('vault-unlock').hidden && !$('vault-bio-unlock').hidden) await unlockWithBio();
}

// From a vault row in the main search: unlock, then go straight to that entry.
let pendingEntryId = null;
function openVaultEntry(id) {
  pendingEntryId = id;
  openVault();
}

async function showLockedPanel() {
  const meta = await readMeta();
  if (meta) {
    const bio = readBio();
    $('vault-bio-unlock').hidden = !(bio && bio.keyId === meta.keyId);
    showVaultPanel('vault-unlock');
    return;
  }
  showVaultPanel('vault-setup');
  // Syncing first prevents a second vault key when one already exists on another device.
  if (loadConfig()) {
    vaultMessage('다른 기기의 금고가 있는지 확인하는 중…');
    await syncNow();
    if (await readMeta()) { await showLockedPanel(); return; }
    vaultMessage('');
  }
}

// Leaving hides the vault at once but keeps it unlocked for a minute, so stepping out to a note
// and back needs no fingerprint. An entry with unsaved changes still locks at once, sealing it.
function closeVault() {
  const unsaved = !$('vault-form').hidden && formDirty;
  if (vaultKey && !unsaved) {
    clearTimeout(idleTimer);
    backToList();
    clearVaultInputs();
    $('vault-entries').replaceChildren();
    clearTimeout(graceTimer);
    graceTimer = setTimeout(lockVault, LEAVE_GRACE_MS);
  } else {
    lockVault();
  }
  if ($('vault').open) $('vault').close();
}

// The phone's back gesture, the ← button and Esc all land here. From an entry, a pattern or the
// settings they return to the list; only from the list do they close and lock the vault.
function vaultBack() {
  const inSubpanel = vaultKey && ['vault-form', 'vault-patterns', 'vault-options'].some(id => !$(id).hidden);
  if (!inSubpanel) { closeVault(); return; }
  // The browser has already stepped back, so put the vault's history entry back.
  history.pushState({ vault: true, note: Boolean(history.state && history.state.note) }, '');
  if (!$('vault-form').hidden && formDirty) {
    vaultMessage('저장하지 않은 내용이 있어요. 저장하거나 취소를 눌러 주세요.', true);
    return;
  }
  backToList();
}

async function unlockWithRawKey(raw, keyId) {
  vaultKey = await importVaultKey(raw);
  vaultKeyId = keyId;
  await reloadEntries();
  renderVaultList();
  showVaultPanel('vault-list');
  resetIdleTimer();
  await restoreDraft();
  const pending = vaultEntries.find(e => e.id === pendingEntryId);
  pendingEntryId = null;
  if (pending && $('vault-form').hidden) openForm(pending);
}

async function unlockWithPassphrase(event) {
  event.preventDefault();
  if (vaultBusy) return;
  const pass = $('vault-pass').value;
  const meta = await readMeta();
  if (!meta || !pass) return;
  vaultBusy = true;
  vaultMessage('여는 중…');
  try {
    const raw = await rawKeyFromPassphrase(meta, pass);
    $('vault-pass').value = '';
    await unlockWithRawKey(raw, meta.keyId);
  } catch (e) {
    vaultMessage(e.message === 'weak-meta' ? '금고 정보가 변조됐을 수 있어 열지 않았어요.' : '금고 비밀번호가 맞지 않아요.', true);
  } finally {
    vaultBusy = false;
  }
}

async function createVault(event) {
  event.preventDefault();
  if (vaultBusy) return;
  const pass = $('vault-new1').value;
  if (pass.length < MIN_PASSPHRASE) { vaultMessage(`금고 비밀번호는 ${MIN_PASSPHRASE}자 이상으로 정하세요.`, true); return; }
  if (pass !== $('vault-new2').value) { vaultMessage('두 비밀번호가 달라요.', true); return; }
  vaultBusy = true;
  vaultMessage('금고를 만드는 중…');
  try {
    // Only create against a confirmed view of the repository; offline could split the vault in two.
    if (loadConfig()) {
      const cfg = loadConfig();
      if (!navigator.onLine) throw new Error('offline');
      const repo = await readRepo(cfg);
      const tree = await readTree(cfg, repo);
      if (tree.vault.has(VAULT_META)) {
        await syncNow();
        vaultBusy = false;
        await showLockedPanel();
        return;
      }
    }
    const raw = randomBytes(32);
    const keyId = bytesToBase64(randomBytes(9));
    const meta = await buildMeta(raw, pass, keyId);
    await updateVaultRecord(VAULT_META, () => ({ id: VAULT_META, data: JSON.stringify(meta), sha: null, dirty: true, deleted: false, rev: 1 }));
    clearVaultInputs();
    await unlockWithRawKey(raw, keyId);
    syncNow();
  } catch (e) {
    vaultMessage(e.message === 'offline' ? '다른 기기의 금고를 확인해야 해서, 금고는 인터넷에 연결된 상태에서 만들어 주세요.' : '금고를 만들지 못했어요. 인터넷과 연결 설정을 확인하세요.', true);
  } finally {
    vaultBusy = false;
  }
}

// Clears the screen at once, then seals any unsaved form so the key can be dropped.
function lockVault() {
  clearTimeout(idleTimer);
  clearTimeout(graceTimer);
  pendingEntryId = null;
  const key = vaultKey;
  const unsaved = key && !$('vault-form').hidden && formDirty ? { id: editingId, ...readForm() } : null;
  vaultKey = null;
  vaultKeyId = null;
  vaultEntries = [];
  vaultPatterns = [];
  editingPatternId = null;
  vaultBroken = 0;
  editingId = null;
  formDirty = false;
  clearVaultInputs();
  for (const id of ['vault-entries', 'vault-pattern-list', 'vault-username-chips', 'vault-pattern-chips', 'vault-url-link', 'vault-memo-links', 'vault-similar']) $(id).replaceChildren();
  if (unsaved) {
    aesEncrypt(key, new TextEncoder().encode(JSON.stringify(unsaved)))
      .then(box => localStorage.setItem(DRAFT_KEY, JSON.stringify(box)))
      .catch(() => {});
  }
  if ($('vault').open) showLockedPanel();
}

async function restoreDraft() {
  const stored = localStorage.getItem(DRAFT_KEY);
  if (!stored) return;
  localStorage.removeItem(DRAFT_KEY);
  try {
    const draft = JSON.parse(new TextDecoder().decode(await aesDecrypt(vaultKey, JSON.parse(stored))));
    openForm(draft.id ? vaultEntries.find(e => e.id === draft.id) || null : null);
    editingId = draft.id;
    fillForm(draft);
    setFormEditing(true);
    formDirty = true;
    vaultMessage('작성 중이던 내용을 복원했어요.');
  } catch { /* sealed with another key */ }
}

// ---------- Entries ----------

async function reloadEntries() {
  const records = (await getVaultRecords()).filter(r => !r.deleted && r.id !== VAULT_META);
  const entries = [];
  const patterns = [];
  let broken = 0;
  for (const record of records) {
    try {
      const plain = await aesDecrypt(vaultKey, JSON.parse(record.data));
      const entry = { ...JSON.parse(new TextDecoder().decode(plain)), id: record.id };
      (entry.kind === 'pattern' ? patterns : entries).push(entry);
    } catch {
      broken += 1; // kept untouched: it may belong to a key another device still has
    }
  }
  vaultEntries = entries;
  vaultPatterns = patterns.sort((a, b) => a.site.localeCompare(b.site, 'ko'));
  vaultBroken = broken;
  localStorage.setItem(VAULT_INDEX_KEY, JSON.stringify(entries.map(e => ({ id: e.id, site: e.site || '', url: e.url || '' }))));
  render();
}

const entryName = e => e.site.trim() || (e.url || '').trim();

function renderVaultList() {
  const q = $('vault-search').value.trim().toLowerCase();
  const shown = vaultEntries
    .filter(e => !q || `${e.site}\n${e.url || ''}\n${e.username}\n${e.memo}`.toLowerCase().includes(q))
    .sort((a, b) => entryName(a).localeCompare(entryName(b), 'ko'));
  $('vault-entries').replaceChildren(...shown.map(entry => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'vault-entry';
    const site = document.createElement('strong');
    site.textContent = entryName(entry) || '(이름 없음)';
    const user = document.createElement('span');
    user.textContent = entry.username;
    open.append(site, user);
    open.onclick = () => openForm(entry);
    const copyUser = document.createElement('button');
    copyUser.type = 'button';
    copyUser.textContent = '아이디';
    copyUser.onclick = () => copySecret(entry.username, '아이디');
    const copyPass = document.createElement('button');
    copyPass.type = 'button';
    copyPass.textContent = '비번';
    copyPass.onclick = () => copySecret(entry.password, '비밀번호');
    li.append(open, copyUser, copyPass);
    return li;
  }));
  const empty = $('vault-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = q ? '찾는 항목이 없어요.' : '아직 항목이 없어요. 먼저 가짜 항목으로 시험해 보세요.';
  $('vault-broken').hidden = vaultBroken === 0;
  $('vault-broken').textContent = `열 수 없는 항목이 ${vaultBroken}개 있어요. 지우지 않고 보관 중이에요.`;
}

const readForm = () => ({
  site: $('vault-site').value,
  url: $('vault-url').value,
  username: $('vault-username').value,
  password: $('vault-password').value,
  memo: $('vault-memo').value,
});

function fillForm(data) {
  $('vault-site').value = data.site || '';
  $('vault-url').value = data.url || '';
  $('vault-username').value = data.username || '';
  $('vault-password').value = data.password || '';
  $('vault-memo').value = data.memo || '';
  renderFormChips();
  renderFormLinks();
  renderSimilar();
  fitMemo();
}

// The address box takes bare domains like naver.com; the memo needs http:// or www. to spot one.
function addressLink(value) {
  const v = value.trim();
  if (/^https?:\/\/\S+$/i.test(v)) return { text: v, href: v };
  if (/^[\w-]+(\.[\w-]+)+([/:?#]\S*)?$/.test(v)) return { text: v, href: `https://${v}` };
  return null;
}

function linkChip({ text, href }) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `↗ ${text}`;
  return a;
}

function renderFormLinks() {
  const address = addressLink($('vault-url').value);
  $('vault-url-link').replaceChildren(...(address ? [linkChip(address)] : []));
  const seen = new Set();
  const memoLinks = findUrls($('vault-memo').value).filter(u => !seen.has(u.href) && seen.add(u.href));
  $('vault-memo-links').replaceChildren(...memoLinks.map(linkChip));
}

function fitMemo() {
  const memo = $('vault-memo');
  // A hidden box measures 0; setFormEditing fits it again once it shows.
  if ($('vault-form').hidden || !memo.offsetParent) return;
  // Collapsing the box to measure it would otherwise make the page jump while typing.
  const top = $('vault').scrollTop;
  memo.style.height = 'auto';
  memo.style.height = `${memo.scrollHeight + memo.offsetHeight - memo.clientHeight}px`;
  $('vault').scrollTop = top;
}

function chip(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

// A caption over a row of chips, so they don't read as more of the form's own buttons.
function withLabel(text, chips) {
  if (!chips.length) return [];
  const label = document.createElement('span');
  label.className = 'chips-label muted small';
  label.textContent = text;
  return [label, ...chips];
}

// Own buttons rather than a datalist, which phone browsers show unreliably.
function renderUsernameChips() {
  const field = $('vault-username');
  const typed = field.value.trim().toLowerCase();
  const counts = new Map();
  for (const e of vaultEntries) if (e.username) counts.set(e.username, (counts.get(e.username) || 0) + 1);
  const names = [...counts.keys()]
    .sort((a, b) => counts.get(b) - counts.get(a))
    .filter(name => name !== field.value && name.toLowerCase().includes(typed))
    .slice(0, MAX_USERNAME_CHIPS);
  $('vault-username-chips').replaceChildren(...withLabel('자주 쓴 아이디로 채우기', names.map(name => chip(name, () => {
    field.value = name;
    formDirty = true;
    renderUsernameChips();
  }))));
}

function renderFormChips() {
  renderUsernameChips();
  $('vault-pattern-chips').replaceChildren(...withLabel('비밀번호 패턴으로 채우기', vaultPatterns.map(p => chip(p.site, () => {
    const field = $('vault-password');
    field.value = p.password;
    field.type = 'text'; // shown, because the point is to adjust it for this site
    $('vault-show').textContent = '가리기';
    formDirty = true;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }))));
}

function showPassword(shown) {
  $('vault-password').type = shown ? 'text' : 'password';
  $('vault-show').textContent = shown ? '가리기' : '보기';
}

// A saved entry opens read-only so a stray tap cannot change it; 수정 makes it editable.
let formEditing = false;
function setFormEditing(editing) {
  formEditing = editing;
  $('vault-form').classList.toggle('viewing', !editing);
  for (const id of ['vault-site', 'vault-url', 'vault-username', 'vault-password', 'vault-memo']) $(id).readOnly = !editing;
  for (const id of ['vault-form-hint', 'vault-username-chips', 'vault-pattern-chips', 'vault-similar', 'vault-save']) $(id).hidden = !editing;
  $('vault-edit').hidden = editing;
  $('vault-delete').hidden = !(editing && editingId);
  $('vault-delete').textContent = '삭제';
  $('vault-delete').dataset.armed = '';
  $('vault-cancel').textContent = editing ? '취소' : '목록';
  // When only looking, empty fields are left out instead of showing as blank boxes.
  for (const id of ['vault-site', 'vault-url', 'vault-username', 'vault-memo']) $(id).closest('label').hidden = !editing && !$(id).value;
  const noPassword = !editing && !$('vault-password').value;
  $('vault-password').closest('.field-row').hidden = noPassword;
  $('vault').querySelector('label[for="vault-password"]').hidden = noPassword;
  for (const id of ['vault-site', 'vault-url', 'vault-username', 'vault-password', 'vault-memo']) $(id).tabIndex = editing ? 0 : -1;
  fitMemo();
}

function openForm(entry) {
  editingId = entry ? entry.id : null;
  formDirty = false;
  duplicateConfirmed = false;
  fillForm(entry || {});
  // A new password is shown while it is typed, so it can be checked without pressing 보기.
  showPassword(!entry);
  setFormEditing(!entry);
  showVaultPanel('vault-form');
  fitMemo();
  if (!entry) $('vault-site').focus();
}

// 취소 while changing a saved entry goes back to viewing it as it was; otherwise to the list.
function cancelForm() {
  const entry = formEditing && editingId && vaultEntries.find(e => e.id === editingId);
  if (!entry) { backToList(); return; }
  formDirty = false;
  duplicateConfirmed = false;
  fillForm(entry);
  setFormEditing(false);
  vaultMessage('');
}

function backToList() {
  editingId = null;
  formDirty = false;
  fillForm({});
  $('vault-search').value = '';
  renderVaultList();
  showVaultPanel('vault-list');
}

async function storeEntry(id, fields) {
  const box = await aesEncrypt(vaultKey, new TextEncoder().encode(JSON.stringify({ ...fields, updated: new Date().toISOString() })));
  await updateVaultRecord(id, r => ({
    id,
    data: JSON.stringify(box),
    sha: r ? r.sha : null,
    dirty: true,
    deleted: false,
    rev: r ? r.rev + 1 : 1,
  }));
  await reloadEntries();
  scheduleSync(500);
}

async function removeEntry(id) {
  const record = await getVaultRecord(id);
  if (record && record.sha) await updateVaultRecord(id, r => { r.deleted = true; return r; });
  else if (record) await removeVaultRecord(id);
  await reloadEntries();
  scheduleSync(500);
}

// ---------- Duplicates ----------

const squash = s => (s || '').toLowerCase().replace(/\s+/g, '');
const hostOf = u => squash(u).replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
// "naver.com" typed as the site name matches https://www.naver.com/login typed as the address.
const siteKeys = e => new Set([squash(e.site), hostOf(e.site), hostOf(e.url)].filter(Boolean));
const sameSite = (a, b) => { const keys = siteKeys(b); return [...siteKeys(a)].some(k => keys.has(k)); };
// Looser: 우체국 is like 부평우체국, and mail.naver.com like naver.com.
const hostKeys = e => [hostOf(e.url), e.site.includes('.') ? hostOf(e.site) : ''].filter(Boolean);
function similarSite(a, b) {
  const [x, y] = [squash(a.site), squash(b.site)];
  if (x && y && Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))) return true;
  return hostKeys(a).some(h => hostKeys(b).some(g => h === g || h.endsWith(`.${g}`) || g.endsWith(`.${h}`)));
}
let duplicateConfirmed = false;

function renderSimilar() {
  const data = readForm();
  const matches = vaultEntries.filter(e => e.id !== editingId && (sameSite(e, data) || similarSite(e, data)));
  $('vault-similar').replaceChildren(...withLabel('같거나 비슷한 사이트 항목 (누르면 열려요)', matches.map(e =>
    chip(e.username ? `${entryName(e)} · ${e.username}` : entryName(e), () => {
      if (editingId && formDirty) { vaultMessage('고친 내용을 먼저 저장하거나 취소해 주세요.', true); return; }
      openForm(e);
    }))));
}

async function saveEntry(event) {
  event.preventDefault();
  if (!formEditing) return; // Enter in a read-only field
  const data = readForm();
  if (!entryName(data)) { vaultMessage('사이트명이나 사이트 주소 중 하나는 적어 주세요.', true); return; }
  // A new entry is checked against every entry for the site or a similar one. An edited one only
  // against the same site and ID, or each save of one of several accounts on a site would ask again.
  const sameId = e => squash(e.username) === squash(data.username);
  const others = vaultEntries.filter(e => e.id !== editingId && sameSite(e, data));
  const similar = editingId ? [] : vaultEntries.filter(e => e.id !== editingId && similarSite(e, data));
  const duplicate = others.find(sameId) || (editingId ? null : others[0] || similar[0]);
  if (duplicate && !duplicateConfirmed) {
    duplicateConfirmed = true;
    const name = entryName(duplicate);
    vaultMessage(!others.includes(duplicate)
      ? `비슷한 '${name}' 항목이 있어요. 다른 곳이라면 저장을 한 번 더 누르세요.`
      : sameId(duplicate)
        ? `'${name}'에 같은 아이디 항목이 이미 있어요. 그래도 따로 저장하려면 저장을 한 번 더 누르세요.`
        : `'${name}' 항목이 이미 있어요. 다른 계정이라면 저장을 한 번 더 누르세요.`, true);
    $('vault').scrollTop = 0;
    return;
  }
  await storeEntry(editingId || newId(), data);
  backToList();
  vaultMessage('저장했어요.');
}

async function deleteEntry() {
  const button = $('vault-delete');
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes';
    button.textContent = '한 번 더 누르면 삭제';
    return;
  }
  await removeEntry(editingId);
  backToList();
  vaultMessage('삭제했어요.');
}

// ---------- Password patterns ----------

function renderPatternList() {
  $('vault-pattern-list').replaceChildren(...vaultPatterns.map(pattern => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'vault-entry';
    open.textContent = pattern.site;
    open.onclick = () => editPattern(pattern);
    const remove = chip('삭제', async () => {
      if (remove.dataset.armed !== 'yes') {
        remove.dataset.armed = 'yes';
        remove.textContent = '한 번 더';
        return;
      }
      await removeEntry(pattern.id);
      showPatterns();
      vaultMessage('패턴을 삭제했어요.');
    });
    remove.className = 'danger';
    li.append(open, remove);
    return li;
  }));
  $('vault-patterns-empty').hidden = vaultPatterns.length > 0;
}

function editPattern(pattern) {
  editingPatternId = pattern ? pattern.id : null;
  $('vault-pattern-label').value = pattern ? pattern.site : '';
  $('vault-pattern-value').value = pattern ? pattern.password : '';
  $('vault-pattern-value').type = 'password';
  $('vault-pattern-show').textContent = '보기';
  $('vault-pattern-save').textContent = pattern ? '패턴 수정' : '패턴 추가';
}

function showPatterns() {
  editPattern(null);
  renderPatternList();
  showVaultPanel('vault-patterns');
}

async function savePattern(event) {
  event.preventDefault();
  const site = $('vault-pattern-label').value.trim();
  const password = $('vault-pattern-value').value;
  if (!site || !password) { vaultMessage('이름과 패턴을 모두 적어 주세요.', true); return; }
  await storeEntry(editingPatternId || newId(), { kind: 'pattern', site, password });
  showPatterns();
  vaultMessage('패턴을 저장했어요.');
}

async function copySecret(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    vaultMessage(`${label}를 복사했어요. 30초 뒤 클립보드를 비우려고 시도해요.`);
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, CLIPBOARD_CLEAR_MS);
  } catch {
    vaultMessage('복사하지 못했어요. 항목을 열어 직접 확인하세요.', true);
  }
}

// ---------- Passphrase and fingerprint ----------

function readBio() {
  try { return JSON.parse(localStorage.getItem(BIO_KEY)); } catch { return null; }
}

async function checkedRawKey() {
  const meta = await readMeta();
  try {
    return { meta, raw: await rawKeyFromPassphrase(meta, $('vault-current').value) };
  } catch {
    vaultMessage('현재 금고 비밀번호가 맞지 않아요.', true);
    return null;
  }
}

function showOptions() {
  const bio = readBio();
  $('vault-bio-on').hidden = Boolean(bio);
  $('vault-bio-off').hidden = !bio;
  showVaultPanel('vault-options');
}

async function changePassphrase() {
  const next = $('vault-change1').value;
  if (next.length < MIN_PASSPHRASE) { vaultMessage(`금고 비밀번호는 ${MIN_PASSPHRASE}자 이상으로 정하세요.`, true); return; }
  if (next !== $('vault-change2').value) { vaultMessage('새 비밀번호 두 칸이 달라요.', true); return; }
  vaultMessage('바꾸는 중…');
  const checked = await checkedRawKey();
  if (!checked) return;
  const meta = await buildMeta(checked.raw, next, checked.meta.keyId);
  await updateVaultRecord(VAULT_META, r => ({ ...r, data: JSON.stringify(meta), dirty: true, rev: r.rev + 1 }));
  $('vault-current').value = '';
  $('vault-change1').value = '';
  $('vault-change2').value = '';
  vaultMessage('금고 비밀번호를 바꿨어요.');
  scheduleSync(500);
}

async function bioSecret(credentialId, prfSalt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: base64ToBytes(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: base64ToBytes(prfSalt) } } },
    },
  });
  const prf = assertion.getClientExtensionResults().prf;
  if (!prf || !prf.results || !prf.results.first) throw new Error('no-prf');
  return crypto.subtle.importKey('raw', prf.results.first, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function enableBio() {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    vaultMessage('이 브라우저는 지문 잠금 해제를 지원하지 않아요.', true);
    return;
  }
  vaultMessage('확인 중…');
  const checked = await checkedRawKey();
  if (!checked) return;
  try {
    const prfSalt = bytesToBase64(randomBytes(32));
    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: '내 노트', id: location.hostname },
        user: { id: randomBytes(16), name: 'vault', displayName: '내 노트 금고' },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        extensions: { prf: { eval: { first: base64ToBytes(prfSalt) } } },
      },
    });
    const credentialId = bytesToBase64(new Uint8Array(credential.rawId));
    const secret = await bioSecret(credentialId, prfSalt);
    const key = await aesEncrypt(secret, checked.raw);
    localStorage.setItem(BIO_KEY, JSON.stringify({ credentialId, prfSalt, key, keyId: checked.meta.keyId }));
    $('vault-current').value = '';
    showOptions();
    vaultMessage('이 기기에서 지문 잠금 해제를 켰어요. 잠근 뒤 다시 열어 확인해 보세요.');
  } catch (e) {
    vaultMessage(e.message === 'no-prf' ? '이 기기나 브라우저는 지문으로 금고를 여는 방식을 지원하지 않아요. 금고 비밀번호로 열어 주세요.' : '지문 등록을 완료하지 못했어요.', true);
  }
}

function disableBio() {
  localStorage.removeItem(BIO_KEY);
  showOptions();
  vaultMessage('이 기기의 지문 잠금 해제를 껐어요.');
}

async function unlockWithBio() {
  if (vaultBusy) return;
  const bio = readBio();
  const meta = await readMeta();
  if (!bio || !meta) return;
  vaultBusy = true;
  try {
    const secret = await bioSecret(bio.credentialId, bio.prfSalt);
    await unlockWithRawKey(await aesDecrypt(secret, bio.key), meta.keyId);
  } catch {
    vaultMessage('지문으로 열지 못했어요. 금고 비밀번호로 열어 주세요.', true);
  } finally {
    vaultBusy = false;
  }
}

// ---------- After sync ----------

async function vaultAfterSync() {
  if (!vaultSyncChanged) return;
  vaultSyncChanged = false;
  if (!$('vault').open) return;
  if (!vaultKey) { await showLockedPanel(); return; }
  const meta = await readMeta();
  if (!meta || meta.keyId !== vaultKeyId) { lockVault(); return; }
  await reloadEntries();
  if (!$('vault-list').hidden) renderVaultList();
  if (!$('vault-patterns').hidden) renderPatternList();
  if (!$('vault-form').hidden) renderFormChips();
}

// ---------- Wiring ----------

$('open-vault').onclick = openVault;
$('vault-close').onclick = () => history.back();
$('vault').addEventListener('cancel', e => { e.preventDefault(); history.back(); });
$('vault-setup').addEventListener('submit', createVault);
$('vault-unlock').addEventListener('submit', unlockWithPassphrase);
$('vault-bio-unlock').onclick = unlockWithBio;
$('vault-lock').onclick = lockVault;
$('vault-add').onclick = () => openForm(null);
$('vault-search').addEventListener('input', renderVaultList);
$('vault-form').addEventListener('submit', saveEntry);
$('vault-form').addEventListener('input', () => { formDirty = true; duplicateConfirmed = false; });
for (const id of ['vault-site', 'vault-url']) $(id).addEventListener('input', renderSimilar);
$('vault-memo').addEventListener('input', fitMemo);
$('vault-memo').addEventListener('input', renderFormLinks);
$('vault-url').addEventListener('input', renderFormLinks);
window.addEventListener('resize', fitMemo);
$('vault-cancel').onclick = cancelForm;
$('vault-edit').onclick = () => { setFormEditing(true); renderSimilar(); };
$('vault-delete').onclick = deleteEntry;
$('vault-show').onclick = () => showPassword($('vault-password').type === 'password');
$('vault-copy').onclick = () => copySecret($('vault-password').value, '비밀번호');
$('vault-username').addEventListener('input', renderUsernameChips);
$('vault-patterns-open').onclick = showPatterns;
$('vault-patterns-back').onclick = backToList;
$('vault-patterns').addEventListener('submit', savePattern);
$('vault-pattern-show').onclick = () => {
  const field = $('vault-pattern-value');
  field.type = field.type === 'password' ? 'text' : 'password';
  $('vault-pattern-show').textContent = field.type === 'password' ? '보기' : '가리기';
};
$('vault-options-open').onclick = showOptions;
$('vault-options-back').onclick = backToList;
$('vault-change').onclick = changePassphrase;
$('vault-bio-on').onclick = enableBio;
$('vault-bio-off').onclick = disableBio;
for (const type of ['pointerdown', 'keydown', 'input']) $('vault').addEventListener(type, resetIdleTimer);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && vaultKey) lockVault(); });
window.addEventListener('pagehide', () => { if (vaultKey) lockVault(); });
// On a PC, switching to another window leaves the vault open and unlocked, so the search has to reset here too.
window.addEventListener('blur', () => {
  if ($('vault-list').hidden || !$('vault-search').value) return;
  $('vault-search').value = '';
  renderVaultList();
});
