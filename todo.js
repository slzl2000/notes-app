'use strict';

// ---------- To-do list ----------
// Kept in one repository file, todos.json, and merged item by item, so ticks made on two
// devices never undo each other: for each item the most recent change wins.

const TODO_KEY = 'notes.todos';
const TODO_LIST_KEY = 'notes.todoList';
const TODO_FILE = 'todos.json';
const TODO_LISTS = [['today', '긴급'], ['short', '단기'], ['long', '장기']]; // keys stay as first saved
const DAY = 86400000;
const DONE_KEEP_DAYS = 30;
// Deletion marks outlive finished items, so a device that was offline cannot bring one back.
const MARK_KEEP_DAYS = 90;

function loadTodos() {
  try {
    const state = JSON.parse(localStorage.getItem(TODO_KEY));
    if (state && Array.isArray(state.items)) return state;
  } catch { /* unreadable; start empty */ }
  return { items: [], sha: null, dirty: false };
}
const saveTodos = state => localStorage.setItem(TODO_KEY, JSON.stringify(state));
const canonTodos = items => JSON.stringify([...items].sort((a, b) => a.id.localeCompare(b.id)));
const byOrder = (a, b) => a.order - b.order;

function mergeTodos(mine, theirs) {
  const byId = new Map(theirs.map(i => [i.id, i]));
  for (const i of mine) {
    const other = byId.get(i.id);
    if (!other || i.updated > other.updated) byId.set(i.id, i);
  }
  return [...byId.values()];
}

// Finished items are tidied away after a month; deletion marks after three.
function cleanTodos(items) {
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  return items
    .filter(i => !(i.deleted && now - Date.parse(i.deleted) > MARK_KEEP_DAYS * DAY))
    .map(i => (!i.deleted && i.done && now - Date.parse(i.done) > DONE_KEEP_DAYS * DAY ? { id: i.id, deleted: stamp, updated: stamp } : i));
}

function changeTodos(change, quiet) {
  const state = loadTodos();
  change(state.items);
  state.dirty = true;
  saveTodos(state);
  if (!quiet) renderTodos();
  scheduleSync(3000);
}

function editTodo(id, fields, quiet) {
  changeTodos(items => {
    const item = items.find(i => i.id === id);
    if (item) Object.assign(item, fields, { updated: new Date().toISOString() });
  }, quiet);
}

const liveIn = (items, list) => items.filter(i => !i.deleted && !i.done && i.list === list).sort(byOrder);
// New and moved items go on top, where the latest one is easy to find.
const topOrder = (items, list) => Math.min(1, ...liveIn(items, list).map(i => i.order)) - 1;

function newTodo(items, text, list, done) {
  const now = new Date().toISOString();
  return { id: newId(), text, memo: '', list, due: '', done: done ? now : '', deleted: '', order: topOrder(items, list), created: now, updated: now };
}

function addTodo(text, list) {
  changeTodos(items => { items.push(newTodo(items, text, list, false)); });
}

function moveTodo(id, list) {
  changeTodos(items => {
    const item = items.find(i => i.id === id);
    if (!item) return;
    Object.assign(item, { list, order: topOrder(items, list), updated: new Date().toISOString() });
  });
  toast(`${toListLabel(TODO_LISTS.find(([key]) => key === list)[1])} 옮겼어요.`);
}

function finishTodo(id, done) {
  openTodoId = null;
  editTodo(id, { done: done ? new Date().toISOString() : '' });
  toast(done ? "완료했어요. 아래 '완료'에 있어요." : '완료를 취소했어요.');
}

// '긴급으로', '단기로': 으로 after a final consonant other than ㄹ.
function toListLabel(name) {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  const final = code >= 0 && code < 11172 ? code % 28 : 0;
  return `${name}${final && final !== 8 ? '으로' : '로'}`;
}

function shiftTodo(id, step) {
  changeTodos(items => {
    const item = items.find(i => i.id === id);
    if (!item) return;
    const list = liveIn(items, item.list);
    const other = list[list.indexOf(item) + step];
    if (!other) return;
    const now = new Date().toISOString();
    [item.order, other.order] = [other.order, item.order];
    item.updated = now;
    other.updated = now;
  });
}

function removeTodo(id) {
  openTodoId = null;
  changeTodos(items => {
    const at = items.findIndex(i => i.id === id);
    const now = new Date().toISOString();
    if (at >= 0) items[at] = { id, deleted: now, updated: now };
  });
  toast('삭제했어요.');
}

function dueLabel(item) {
  if (!item.due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(`${item.due}T00:00`) - today) / DAY);
  if (days < 0) return { text: `${-days}일 지남`, over: true };
  return { text: days === 0 ? '오늘까지' : `D-${days}`, over: days === 0 };
}

// ---------- Drawing ----------

let openTodoId = null;
let todoRenderPending = false;

// A sync must not redraw the list under someone typing in it.
function typingInTodo() {
  const a = document.activeElement;
  return Boolean(a && a.closest && a.closest('.todo-detail') && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
}

function fitTodoMemo(box) {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight + 2}px`;
}

// Redrawing replaces the row that was just tapped; some browsers then move focus to the top of
// the screen and scroll with it, so the scroll position and the focused row are put back.
function renderTodos() {
  if (typingInTodo()) { todoRenderPending = true; return; }
  todoRenderPending = false;
  const page = $('todo');
  const top = page.scrollTop;
  const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('[data-todo]') : null;
  drawTodos();
  const again = focused && page.querySelector(`[data-todo="${focused.dataset.todo}"] .todo-text`);
  if (again && again.getClientRects().length) again.focus({ preventScroll: true });
  // Focus left on a removed row, or on a finished item now in the folded '완료' list, is lost;
  // the page itself takes it, so the browser does not hand it to the top of the screen.
  const active = document.activeElement;
  if (!page.contains(active) || !active.getClientRects().length) $('todo-main').focus({ preventScroll: true });
  page.scrollTop = top;
  requestAnimationFrame(() => { page.scrollTop = top; });
}

function drawTodos() {
  const items = loadTodos().items.filter(i => !i.deleted);
  for (const [list] of TODO_LISTS) {
    const live = liveIn(items, list);
    $(`todo-${list}-count`).textContent = live.length || '';
    $(`todo-${list}`).replaceChildren(...live.map(todoRow));
    $(`todo-${list}-empty`).hidden = live.length > 0;
  }
  const done = items.filter(i => i.done).sort((a, b) => b.done.localeCompare(a.done));
  $('todo-done-count').textContent = done.length;
  $('todo-done-list').replaceChildren(...done.map(todoRow));
  $('todo-done').hidden = done.length === 0;
}

function todoButton(label, onclick, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  b.onclick = onclick;
  return b;
}

function todoRow(item) {
  const li = document.createElement('li');
  li.dataset.todo = item.id;
  if (item.done) li.className = 'done';
  const row = document.createElement('div');
  row.className = 'todo-row';
  // Only a marker: finishing an item is done from its details, so it cannot happen by a stray tap.
  const mark = document.createElement('span');
  mark.className = 'todo-mark';
  mark.setAttribute('aria-hidden', 'true');
  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'todo-text';
  label.setAttribute('aria-expanded', String(openTodoId === item.id));
  const text = document.createElement('strong');
  text.textContent = item.text;
  label.append(text);
  const note = item.done ? `${formatDate(item.done)} 완료` : (item.memo || '').split('\n').find(l => l.trim()) || '';
  if (note) {
    const sub = document.createElement('span');
    sub.textContent = note;
    label.append(sub);
  }
  label.onclick = () => toggleTodoDetail(item.id);
  row.append(mark, label);
  const due = item.done ? null : dueLabel(item);
  if (due) {
    const badge = document.createElement('span');
    badge.className = due.over ? 'todo-due over' : 'todo-due';
    badge.textContent = due.text;
    row.append(badge);
  }
  li.append(row);
  if (openTodoId === item.id) li.append(todoDetail(item, text));
  return li;
}

// Opening or closing an item only swaps rows, and the tapped item stays where it was on screen
// even when an item above it closes.
function toggleTodoDetail(id) {
  const page = $('todo');
  const tapped = page.querySelector(`[data-todo="${id}"]`);
  const before = tapped ? tapped.getBoundingClientRect().top : 0;
  const swap = rowId => {
    const old = page.querySelector(`[data-todo="${rowId}"]`);
    const item = loadTodos().items.find(i => i.id === rowId);
    if (!old) return;
    if (!item || item.deleted) { old.remove(); return; }
    const row = todoRow(item); // drawn fresh, so edits made while it was open show up
    old.replaceWith(row);
    return row;
  };
  const previous = openTodoId;
  openTodoId = previous === id ? null : id;
  if (previous && previous !== id) swap(previous);
  const row = swap(id);
  if (!row) return;
  row.querySelector('.todo-text').focus({ preventScroll: true });
  page.scrollTop += row.getBoundingClientRect().top - before;
  // An item opened near the bottom is lifted just enough to show its details, never past its title.
  const box = row.getBoundingClientRect();
  const hidden = box.bottom - page.clientHeight;
  if (openTodoId === id && hidden > 0) page.scrollTop += Math.min(hidden, box.top - 60);
}

function todoDetail(item, titleEl) {
  const box = document.createElement('div');
  box.className = 'todo-detail';
  const field = (caption, control) => {
    const label = document.createElement('label');
    label.append(caption, control);
    return label;
  };
  const text = document.createElement('input');
  text.value = item.text;
  text.autocomplete = 'off';
  text.oninput = () => {
    const value = text.value.trim();
    if (!value) return;
    titleEl.textContent = value;
    editTodo(item.id, { text: value }, true);
  };
  const memo = document.createElement('textarea');
  memo.rows = 2;
  memo.value = item.memo || '';
  memo.oninput = () => { fitTodoMemo(memo); editTodo(item.id, { memo: memo.value }, true); };
  const due = document.createElement('input');
  due.type = 'date';
  due.value = item.due || '';
  due.onchange = () => editTodo(item.id, { due: due.value }, true);
  box.append(field('할 일', text), field('메모', memo), field('마감일 (없어도 돼요)', due));

  // Edits are saved as they are typed; this only folds the item away again.
  const close = document.createElement('div');
  close.className = 'row todo-close';
  close.append(todoButton('작성 완료', () => toggleTodoDetail(item.id), 'primary'));
  box.append(close);

  // Two fixed rows, with delete at the end of the second, so asking to confirm moves nothing.
  const moves = document.createElement('div');
  moves.className = 'row todo-actions';
  moves.append(item.done
    ? todoButton('완료 취소', () => finishTodo(item.id, false))
    : todoButton('완료로 이동', () => finishTodo(item.id, true)));
  const order = document.createElement('div');
  order.className = 'row todo-actions';
  if (!item.done) {
    for (const [list, name] of TODO_LISTS) {
      if (list !== item.list) moves.append(todoButton(toListLabel(name), () => moveTodo(item.id, list)));
    }
    order.append(todoButton('↑ 위로', () => shiftTodo(item.id, -1)), todoButton('↓ 아래로', () => shiftTodo(item.id, 1)));
  }
  const remove = todoButton('삭제', () => {
    if (remove.dataset.armed) { removeTodo(item.id); return; }
    remove.dataset.armed = '1';
    remove.textContent = '정말 삭제';
    remove.className = 'todo-remove danger-bg';
  }, 'todo-remove text danger');
  order.append(remove);
  box.append(moves, order);
  requestAnimationFrame(() => fitTodoMemo(memo));
  return box;
}

// ---------- Import from notes ----------

const TODO_PREFIX = /^(?:[☐☑✓✔□■•·\-*]|\d+[.)])\s*/;

function todoLinesOf(note) {
  return note.text.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => ({ text: l.replace(TODO_PREFIX, '').trim(), done: /^[☑✓✔]/.test(l) }))
    .filter(l => l.text);
}

let importNotes = [];

async function openTodoImport() {
  importNotes = (await getAll())
    .filter(n => !n.deleted && !n.trashed && hasContent(n))
    .sort((a, b) => Number(titleOf(b).includes('할 일')) - Number(titleOf(a).includes('할 일')) || b.updated.localeCompare(a.updated));
  $('todo-import-note').replaceChildren(...importNotes.map(n => {
    const option = document.createElement('option');
    option.value = n.id;
    option.textContent = titleOf(n).slice(0, 40);
    return option;
  }));
  $('todo-import-list').value = 'short';
  previewTodoImport();
  showTodoPanel('todo-import');
}

function previewTodoImport() {
  const note = importNotes.find(n => n.id === $('todo-import-note').value);
  const lines = note ? todoLinesOf(note) : [];
  $('todo-import-run').disabled = lines.length === 0;
  $('todo-import-preview').textContent = lines.length
    ? `${lines.length}개 항목: ${lines.slice(0, 3).map(l => l.text.slice(0, 20)).join(', ')}${lines.length > 3 ? ' …' : ''}`
    : '가져올 줄이 없어요.';
}

function runTodoImport() {
  const note = importNotes.find(n => n.id === $('todo-import-note').value);
  if (!note) return;
  const list = $('todo-import-list').value;
  let added = 0;
  let skipped = 0;
  changeTodos(items => {
    const existing = new Set(items.filter(i => !i.deleted).map(i => i.text));
    // Each new item goes on top, so lines are added last first to keep the note's order.
    for (const line of todoLinesOf(note).reverse()) {
      if (existing.has(line.text)) { skipped += 1; continue; }
      items.push(newTodo(items, line.text, list, line.done));
      existing.add(line.text);
      added += 1;
    }
  }, true);
  showTodoPanel('todo-main');
  renderTodos();
  toast(`${added}개를 가져왔어요.${skipped ? ` 이미 있는 ${skipped}개는 건너뛰었어요.` : ''} 원래 노트는 그대로 있어요.`);
}

// ---------- Opening and closing ----------

function showTodoPanel(id) {
  $('todo-main').hidden = id !== 'todo-main';
  $('todo-import').hidden = id !== 'todo-import';
  $('todo-import-open').hidden = id !== 'todo-main';
  $('todo').scrollTop = 0;
}

function openTodo() {
  const state = loadTodos();
  const cleaned = cleanTodos(state.items);
  if (canonTodos(cleaned) !== canonTodos(state.items)) {
    saveTodos({ ...state, items: cleaned, dirty: true });
    scheduleSync(3000);
  }
  openTodoId = null;
  $('todo-new-list').value = localStorage.getItem(TODO_LIST_KEY) || 'short';
  showTodoPanel('todo-main');
  renderTodos();
  history.pushState({ todo: true }, '');
  $('todo').showModal();
}

// The phone's back button leaves the import screen first, then the list.
function todoBack() {
  if (!$('todo-import').hidden) {
    history.pushState({ todo: true }, '');
    showTodoPanel('todo-main');
    return;
  }
  $('todo').close();
}

// ---------- Sync ----------

async function syncTodos(cfg, remoteSha) {
  let state = loadTodos();
  if (remoteSha && remoteSha !== state.sha) {
    const blob = await api(cfg, `/repos/${cfg.repo}/git/blobs/${remoteSha}`);
    const theirs = (JSON.parse(fromBase64(blob.content)).items || []).filter(i => i && i.id && i.updated);
    state = loadTodos(); // edits made while downloading
    const merged = cleanTodos(mergeTodos(state.items, theirs));
    state = { items: merged, sha: remoteSha, dirty: canonTodos(merged) !== canonTodos(theirs) };
    saveTodos(state);
  } else if (!remoteSha && state.sha) {
    state = { ...state, sha: null, dirty: state.items.length > 0 }; // the file was removed or the repository replaced
    saveTodos(state);
  }
  if (!state.dirty) return 0;
  const sent = state.items;
  const res = await api(cfg, `/repos/${cfg.repo}/contents/${TODO_FILE}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: '할 일',
      content: toBase64(JSON.stringify({ version: 1, items: sent }, null, 1)),
      ...(state.sha ? { sha: state.sha } : {}),
    }),
  });
  const now = loadTodos();
  saveTodos({ ...now, sha: res.content.sha, dirty: canonTodos(now.items) !== canonTodos(sent) });
  return 1;
}

function resetTodoSync() {
  const state = loadTodos();
  saveTodos({ ...state, sha: null, dirty: state.items.length > 0 });
}

// ---------- Wiring ----------

$('open-todo').onclick = openTodo;
$('todo-close').onclick = () => $('todo').close();
$('todo').addEventListener('close', () => { if (history.state && history.state.todo) history.back(); });
$('todo-add').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('todo-new').value.trim();
  if (!text) return;
  addTodo(text, $('todo-new-list').value);
  $('todo-new').value = '';
  $('todo-new').focus();
});
$('todo-new-list').onchange = () => localStorage.setItem(TODO_LIST_KEY, $('todo-new-list').value);
$('todo-import-open').onclick = openTodoImport;
$('todo-import-note').onchange = previewTodoImport;
$('todo-import-run').onclick = runTodoImport;
$('todo-import-cancel').onclick = () => showTodoPanel('todo-main');
$('todo').addEventListener('focusout', () => setTimeout(() => { if (todoRenderPending && !typingInTodo()) renderTodos(); }, 0));
