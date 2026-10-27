// Room Lab — upload a room, click furniture to remove it, drop in furniture you want to try.
// Selection runs locally (SAM in a Web Worker). The actual photo editing is done by
// Google's Gemini image model, called straight from the browser with your own API key.

const $ = (s) => document.querySelector(s);

const MODEL_OPTIONS = [
  ['gemini-2.5-flash-image', 'Gemini 2.5 Flash Image (cheapest, fast)'],
  ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'],
  ['gemini-3-pro-image-preview', 'Gemini 3 Pro Image (best quality, slower)'],
  ['custom', 'Custom…'],
];
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const SEL_COLORS = [[230, 70, 60], [60, 130, 230], [235, 160, 40], [150, 80, 220], [30, 170, 160], [220, 70, 160]];
const ROOM_MAX = 1600;   // longest side of the working photo
const ITEM_MAX = 1024;   // longest side of furniture photos sent to the model

// ---------- small helpers
const store = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let uidN = 0;
const uid = () => `${Date.now().toString(36)}${(uidN++).toString(36)}`;

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Could not read that image (HEIC photos only open in Safari — try a JPG or PNG).'));
    i.src = src;
  });
}
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
function imageToDataURL(img, maxDim, type = 'image/jpeg', q = 0.92) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  const x = c.getContext('2d');
  if (type === 'image/jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, q);
}
function inlinePart(dataURL) {
  const [head, data] = dataURL.split(',');
  return { inlineData: { mimeType: head.slice(5, head.indexOf(';')), data } };
}
function nearestAspect(w, h) {
  const r = Math.log(w / h);
  let best = ASPECTS[0], d = Infinity;
  for (const a of ASPECTS) {
    const [x, y] = a.split(':').map(Number);
    const dd = Math.abs(Math.log(x / y) - r);
    if (dd < d) { d = dd; best = a; }
  }
  return best;
}

let toastTimer;
function toast(msg, isErr = false, ms = 4500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? Math.max(ms, 8000) : ms);
}

// ---------- state
const state = {
  versions: [],      // { id, dataURL, img, w, h, label, parent, request }
  cur: -1,
  mode: 'remove',
  selections: [],    // { id, n, points:[{x,y,label}] (0..1), mask, color, overlay, pending, failed }
  selCount: 0,
  items: [],         // { id, name, dataURL, img, place: null | {type:'point',x,y} | {type:'box',x,y,w,h} } (0..1)
  placing: null,     // item id waiting for a click on the photo
  compare: false,
  compareX: 0.5,
  busy: false,
  drag: null,
};
const settings = {
  get key() { return store.get('roomlab.key'); },
  get model() { return store.get('roomlab.model', MODEL_OPTIONS[0][0]); },
};
const cur = () => state.versions[state.cur] || null;

// ---------- canvas
const canvas = $('#stage');
const ctx = canvas.getContext('2d');

function toImageCoords(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

function render() {
  const v = cur();
  if (!v) return;
  if (canvas.width !== v.w || canvas.height !== v.h) { canvas.width = v.w; canvas.height = v.h; }
  const W = v.w, H = v.h, s = Math.max(W, H) / 1000;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(v.img, 0, 0, W, H);

  const parent = v.parent != null ? state.versions[v.parent] : null;
  if (state.compare && parent) {
    const cx = Math.round(W * state.compareX);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, cx, H); ctx.clip();
    ctx.drawImage(parent.img, 0, 0, W, H);
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - 1.5 * s, 0, 3 * s, H);
    label(ctx, 'Before', 14 * s, 14 * s, s, 'left');
    label(ctx, 'After', W - 14 * s, 14 * s, s, 'right');
    return;
  }

  if (state.mode === 'remove') {
    for (const sel of state.selections) {
      if (sel.overlay) ctx.drawImage(sel.overlay, 0, 0, W, H);
      const p = sel.points[0];
      if (!sel.overlay || sel.pending) {
        ring(ctx, p.x * W, p.y * H, 16 * s, s, `rgb(${sel.color})`, sel.pending);
      }
      for (const q of sel.points.slice(1)) dotMark(ctx, q.x * W, q.y * H, s, q.label);
    }
  } else {
    state.items.forEach((it, i) => drawPlacement(ctx, it, i + 1, W, H, s, it.id === state.placing));
    if (state.drag?.box) {
      const b = state.drag.box;
      ctx.save();
      ctx.setLineDash([10 * s, 6 * s]);
      ctx.strokeStyle = '#2f8f5b'; ctx.lineWidth = 3 * s;
      ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
      ctx.restore();
    }
  }
}

function label(c, text, x, y, s, align) {
  c.save();
  c.font = `600 ${16 * s}px system-ui, sans-serif`;
  const w = c.measureText(text).width + 16 * s;
  const bx = align === 'right' ? x - w : x;
  c.fillStyle = 'rgba(0,0,0,.6)';
  c.beginPath(); c.roundRect(bx, y, w, 28 * s, 6 * s); c.fill();
  c.fillStyle = '#fff'; c.textBaseline = 'middle';
  c.fillText(text, bx + 8 * s, y + 14 * s);
  c.restore();
}
function ring(c, x, y, r, s, color, dashed) {
  c.save();
  c.lineWidth = 4 * s; c.strokeStyle = color;
  if (dashed) c.setLineDash([6 * s, 5 * s]);
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
  c.fillStyle = color; c.beginPath(); c.arc(x, y, 4 * s, 0, Math.PI * 2); c.fill();
  c.restore();
}
function dotMark(c, x, y, s, lab) {
  c.save();
  c.fillStyle = lab ? '#fff' : '#111';
  c.strokeStyle = lab ? '#111' : '#fff';
  c.lineWidth = 2 * s;
  c.beginPath(); c.arc(x, y, 6 * s, 0, Math.PI * 2); c.fill(); c.stroke();
  c.restore();
}
function badge(c, x, y, n, s, color = '#2f8f5b') {
  const r = 17 * s;
  c.save();
  c.fillStyle = color; c.strokeStyle = '#fff'; c.lineWidth = 3 * s;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.stroke();
  c.fillStyle = '#fff'; c.font = `700 ${19 * s}px system-ui, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(String(n), x, y + 1 * s);
  c.restore();
}
function drawPlacement(c, it, n, W, H, s, active) {
  const p = it.place;
  if (!p) return;
  const color = active ? '#22b36b' : '#2f8f5b';
  if (p.type === 'box') {
    c.save();
    c.setLineDash([10 * s, 6 * s]);
    c.strokeStyle = color; c.lineWidth = 4 * s;
    c.fillStyle = 'rgba(47,143,91,.15)';
    c.fillRect(p.x * W, p.y * H, p.w * W, p.h * H);
    c.strokeRect(p.x * W, p.y * H, p.w * W, p.h * H);
    c.restore();
    badge(c, (p.x + p.w / 2) * W, (p.y + p.h / 2) * H, n, s, color);
  } else {
    badge(c, p.x * W, p.y * H, n, s, color);
  }
}

// Colour a mask into a see-through overlay with a solid edge.
function buildOverlay(mask, w, h, rgb, alpha = 0.45) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  const img = x.createImageData(w, h);
  const d = img.data;
  const a = Math.round(alpha * 255);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      if (!mask[i]) continue;
      const edge = xx === 0 || yy === 0 || xx === w - 1 || yy === h - 1 ||
        !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w];
      const o = i * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2];
      d[o + 3] = edge ? 255 : a;
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}

// ---------- segmentation worker
const sam = { worker: null, ready: false, failed: false, embedded: null };

function setSamStatus(t) { $('#samStatus').textContent = t; }

function initSam() {
  try {
    sam.worker = new Worker('./sam-worker.js', { type: 'module' });
  } catch {
    samFailed('Click detection is unavailable in this browser, so clicks drop a marker instead. That still works, just less precise.');
    return;
  }
  sam.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'status') setSamStatus(m.text);
    else if (m.type === 'ready') {
      sam.ready = true;
      setSamStatus(m.device === 'webgpu' ? 'Object detector ready (GPU).' : 'Object detector ready.');
      embedCurrent();
    } else if (m.type === 'embedded') {
      sam.embedded = m.imageId;
      if (cur()?.id === m.imageId) setSamStatus('Ready: click any piece of furniture.');
      // Selections clicked while the photo was still being analysed.
      state.selections.filter((s) => s.pending && !s.sent).forEach(requestMask);
    } else if (m.type === 'mask') onMask(m);
    else if (m.type === 'error') {
      if (m.during === 'decode' && m.selId) {
        const sel = state.selections.find((s) => s.id === m.selId);
        if (sel) { sel.pending = false; sel.failed = true; render(); updateRemoveUI(); }
      } else {
        console.error(m.message);
        samFailed('Could not load click detection, so clicks drop a marker instead. That still works, just less precise.');
      }
    }
  };
  sam.worker.onerror = (e) => {
    console.error(e);
    samFailed('Could not load click detection, so clicks drop a marker instead. That still works, just less precise.');
  };
  sam.worker.postMessage({ type: 'load' });
}
function samFailed(text) {
  sam.failed = true;
  setSamStatus(text);
  state.selections.forEach((s) => { s.pending = false; });
  render(); updateRemoveUI();
}
function embedCurrent() {
  const v = cur();
  if (!v || !sam.ready || sam.failed || sam.embedded === v.id) return;
  setSamStatus('Analysing photo…');
  sam.worker.postMessage({ type: 'embed', imageId: v.id, url: v.dataURL });
}
function requestMask(sel) {
  const v = cur();
  if (!v || sam.failed) { sel.pending = false; return; }
  if (!sam.ready || sam.embedded !== v.id) { sel.pending = true; sel.sent = false; return; }
  sel.pending = true; sel.sent = true;
  sam.worker.postMessage({ type: 'decode', selId: sel.id, imageId: v.id, points: sel.points });
}
function onMask(m) {
  const v = cur();
  const sel = state.selections.find((s) => s.id === m.selId);
  if (!sel || !v || v.id !== m.imageId) return;
  sel.mask = m.mask; sel.mw = m.w; sel.mh = m.h;
  sel.overlay = buildOverlay(m.mask, m.w, m.h, sel.color);
  sel.pending = false; sel.failed = false;
  render(); updateRemoveUI();
}

// ---------- remove mode
function hitSelection(p) {
  const v = cur();
  for (let i = state.selections.length - 1; i >= 0; i--) {
    const s = state.selections[i];
    if (s.mask) {
      const x = Math.floor(p.x * (s.mw - 1)), y = Math.floor(p.y * (s.mh - 1));
      if (s.mask[y * s.mw + x]) return s;
    } else {
      const q = s.points[0];
      const dx = (q.x - p.x) * v.w, dy = (q.y - p.y) * v.h;
      if (Math.hypot(dx, dy) < 22 * Math.max(v.w, v.h) / 1000) return s;
    }
  }
  return null;
}
function handleRemoveClick(p, e) {
  const refine = e.shiftKey || e.altKey || e.button === 2;
  const last = state.selections[state.selections.length - 1];
  if (refine && last && !sam.failed) {
    last.points.push({ x: p.x, y: p.y, label: (e.altKey || e.button === 2) ? 0 : 1 });
    requestMask(last);
  } else {
    const hit = hitSelection(p);
    if (hit) {
      state.selections = state.selections.filter((s) => s !== hit);
    } else {
      state.selCount++;
      const sel = {
        id: uid(), n: state.selCount, points: [{ x: p.x, y: p.y, label: 1 }],
        mask: null, overlay: null, pending: false, failed: false,
        color: SEL_COLORS[(state.selCount - 1) % SEL_COLORS.length],
      };
      state.selections.push(sel);
      requestMask(sel);
    }
  }
  render(); updateRemoveUI();
}
function updateRemoveUI() {
  const list = $('#selList');
  list.innerHTML = '';
  for (const s of state.selections) {
    const li = document.createElement('li');
    li.className = 'chip';
    const tag = s.pending ? ' …' : (!s.mask ? ' (marker)' : '');
    li.innerHTML = `<span class="dot" style="background:rgb(${s.color})"></span>Object ${s.n}${tag}<button title="Unselect" aria-label="Unselect">×</button>`;
    li.querySelector('button').onclick = () => {
      state.selections = state.selections.filter((x) => x !== s);
      render(); updateRemoveUI();
    };
    list.appendChild(li);
  }
  const n = state.selections.length;
  $('#removeBtn').disabled = !n || state.busy;
  $('#removeBtn').textContent = n ? `Remove ${n} object${n > 1 ? 's' : ''}` : 'Remove selected';
}

function annotatedForRemoval(v) {
  const c = document.createElement('canvas');
  c.width = v.w; c.height = v.h;
  const x = c.getContext('2d');
  x.drawImage(v.img, 0, 0);
  const s = Math.max(v.w, v.h) / 1000;
  for (const sel of state.selections) {
    if (sel.mask) {
      x.drawImage(buildOverlay(sel.mask, sel.mw, sel.mh, [255, 0, 0], 0.6), 0, 0, v.w, v.h);
    } else {
      const p = sel.points[0];
      x.save();
      x.strokeStyle = '#ff0000'; x.lineWidth = 6 * s;
      x.beginPath(); x.arc(p.x * v.w, p.y * v.h, 30 * s, 0, Math.PI * 2); x.stroke();
      x.restore();
    }
  }
  return c.toDataURL('image/jpeg', 0.9);
}

function removePrompt(hasMarkers, notes) {
  return [
    'Edit this interior photo.',
    `Image 1 is the original photo of a room. Image 2 is the exact same photo where the objects to remove are covered with a red overlay${hasMarkers ? ' or circled in red (a circle means: remove the whole object under it)' : ''}.`,
    'Task: remove every object marked in red from Image 1. Rebuild what would naturally be behind each one: continue the floor, rug, walls, skirting boards, windows and anything else so it looks like the object was never there. Also remove the shadows and reflections those objects cast.',
    'Keep everything else exactly the same: same camera angle, framing, perspective, lighting, colours and every other object. Do not add anything new. Return a clean photo with no red overlay, circles or markings.',
    notes ? `Extra instructions from me: ${notes}` : '',
  ].filter(Boolean).join('\n\n');
}

async function runRemove() {
  const v = cur();
  if (!v || !state.selections.length || state.busy) return;
  if (state.selections.some((s) => s.pending)) {
    if (sam.ready) {
      toast('Still outlining a selection, give it a second.');
      return;
    }
    // Detector still downloading: send the clicks as circled markers instead of waiting.
    state.selections.forEach((s) => { s.pending = false; });
  }
  const hasMarkers = state.selections.some((s) => !s.mask);
  const parts = [
    { text: 'Image 1 (original photo):' },
    inlinePart(imageToDataURL(v.img, ROOM_MAX)),
    { text: 'Image 2 (same photo, objects to remove marked in red):' },
    inlinePart(annotatedForRemoval(v)),
    { text: removePrompt(hasMarkers, $('#removeNotes').value.trim()) },
  ];
  const n = state.selections.length;
  await generate(parts, `Removed ${n}`, state.cur, 'remove');
}

// ---------- add mode
async function addItemFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|avif|webp)$/i.test(f.name));
  if (!list.length) return;
  let firstNew = null;
  for (const f of list) {
    try {
      const raw = await fileToDataURL(f);
      const img0 = await loadImage(raw);
      const keepAlpha = /png|webp|avif/.test(f.type);
      const dataURL = imageToDataURL(img0, ITEM_MAX, keepAlpha ? 'image/png' : 'image/jpeg');
      const img = await loadImage(dataURL);
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'furniture';
      const it = { id: uid(), name, dataURL, img, place: null };
      state.items.push(it);
      firstNew ??= it.id;
    } catch (err) { toast(err.message, true); }
  }
  setMode('add');
  if (firstNew && !state.placing) state.placing = firstNew;
  updateAddUI(); render();
}
function nextUnplaced() {
  return state.items.find((i) => !i.place)?.id ?? null;
}
function updateAddUI() {
  const list = $('#itemList');
  list.innerHTML = '';
  state.items.forEach((it, idx) => {
    const li = document.createElement('li');
    li.className = 'item' + (it.id === state.placing ? ' placing' : '');
    const where = it.id === state.placing ? 'Click the photo to place it'
      : it.place ? (it.place.type === 'box' ? 'Placed (area)' : 'Placed') : 'Not placed, won\'t be added';
    li.innerHTML = `
      <span class="badge">${idx + 1}</span>
      <img alt="">
      <div><input type="text" aria-label="Item name"><small>${where}</small></div>
      <div class="acts">
        <button class="ghost place">${it.id === state.placing ? 'Cancel' : it.place ? 'Move' : 'Place'}</button>
        <button class="ghost del" title="Delete">Delete</button>
      </div>`;
    li.querySelector('img').src = it.dataURL;
    const input = li.querySelector('input');
    input.value = it.name;
    input.oninput = () => { it.name = input.value; };
    li.querySelector('.place').onclick = () => {
      state.placing = state.placing === it.id ? null : it.id;
      updateAddUI(); render();
    };
    li.querySelector('.del').onclick = () => {
      state.items = state.items.filter((x) => x !== it);
      if (state.placing === it.id) state.placing = nextUnplaced();
      updateAddUI(); render();
    };
    list.appendChild(li);
  });
  canvas.classList.toggle('placing', state.mode === 'add' && !!state.placing);
  const placed = state.items.filter((i) => i.place).length;
  $('#addBtn').disabled = !placed || state.busy;
  $('#addBtn').textContent = placed ? `Add ${placed} item${placed > 1 ? 's' : ''} to room` : 'Add to room';
}
function hitPlacement(p) {
  const v = cur();
  const r = 24 * Math.max(v.w, v.h) / 1000;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const q = state.items[i].place;
    if (!q) continue;
    if (q.type === 'box' && p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h) return state.items[i];
    if (q.type === 'point' && Math.hypot((q.x - p.x) * v.w, (q.y - p.y) * v.h) < r) return state.items[i];
  }
  return null;
}
function finishPlacement(start, end) {
  const v = cur();
  const dist = Math.hypot((end.x - start.x) * v.w, (end.y - start.y) * v.h);
  const isBox = dist > 12 * Math.max(v.w, v.h) / 1000;

  if (!state.placing) {
    const hit = hitPlacement(start);
    if (hit) { state.placing = hit.id; }
    else if (state.items.length) toast('Hit "Place" on an item first, then click the photo.');
    else toast('Upload a furniture photo first.');
    updateAddUI(); render();
    return;
  }
  const it = state.items.find((i) => i.id === state.placing);
  if (!it) return;
  it.place = isBox
    ? { type: 'box', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }
    : { type: 'point', x: end.x, y: end.y };
  state.placing = nextUnplaced();
  updateAddUI(); render();
}

function annotatedForAdding(v) {
  const c = document.createElement('canvas');
  c.width = v.w; c.height = v.h;
  const x = c.getContext('2d');
  x.drawImage(v.img, 0, 0);
  const s = Math.max(v.w, v.h) / 1000;
  state.items.forEach((it, i) => drawPlacement(x, it, i + 1, v.w, v.h, s * 1.3, false));
  return c.toDataURL('image/jpeg', 0.9);
}
function addPrompt(notes) {
  return [
    'Edit this interior photo by adding furniture.',
    'Image 1 is the current photo of the room. Image 2 is the same photo with numbered green markers showing where each new item goes: a numbered dot means place it there, a dashed green box shows roughly the area and size it should take up.',
    'After that comes one product photo per item, labelled with its marker number.',
    'Task: put each item into Image 1 at its numbered marker. Treat each product photo as the exact design to reproduce: keep its shape, colour, material, pattern and proportions. Ignore the background of the product photos. Scale each item realistically for the room, match the room\'s perspective and camera angle, and match its lighting, with natural contact shadows where it touches the floor or wall.',
    'Keep everything else in the room exactly the same. Return a clean photorealistic photo with no markers, numbers or boxes.',
    notes ? `Extra instructions from me: ${notes}` : '',
  ].filter(Boolean).join('\n\n');
}
async function runAdd() {
  const v = cur();
  const placed = state.items.map((it, i) => ({ it, n: i + 1 })).filter(({ it }) => it.place);
  if (!v || !placed.length || state.busy) return;
  const parts = [
    { text: 'Image 1 (room photo):' },
    inlinePart(imageToDataURL(v.img, ROOM_MAX)),
    { text: 'Image 2 (placement guide with numbered green markers):' },
    inlinePart(annotatedForAdding(v)),
  ];
  for (const { it, n } of placed) {
    const where = it.place.type === 'box' ? `fill roughly the green box marked ${n}` : `place it at green marker ${n}`;
    parts.push({ text: `Item ${n}: ${it.name || 'furniture'}. ${where}.` }, inlinePart(it.dataURL));
  }
  parts.push({ text: addPrompt($('#addNotes').value.trim()) });
  const names = placed.map(({ it }) => it.name || 'item').join(', ');
  const ok = await generate(parts, `Added ${names}`, state.cur, 'add');
  if (ok) {
    placed.forEach(({ it }) => { it.place = null; });
    state.placing = null;
    updateAddUI(); render();
  }
}

// ---------- Gemini
function apiError(status, text) {
  let msg = text;
  try { msg = JSON.parse(text).error?.message || text; } catch { /* not JSON */ }
  if (status === 400 && /api key/i.test(msg)) return 'Your Gemini API key was rejected. Check it in Settings.';
  if (status === 403) return `Access denied by Google: ${msg}`;
  if (status === 404) return `Model "${settings.model}" wasn't found. Pick another one in Settings.`;
  if (status === 429) return `Google says you've hit a rate limit or quota (image models usually need billing turned on for your key). ${msg}`;
  return `Gemini error ${status}: ${msg}`;
}
async function callGemini(parts, aspect) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  const body = (withAspect) => JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(withAspect ? { imageConfig: { aspectRatio: aspect } } : {}),
    },
  });
  const post = (withAspect) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.key },
    body: body(withAspect),
  });

  let res = await post(true);
  if (!res.ok) {
    let txt = await res.text();
    // Older models don't know imageConfig; retry without it.
    if (res.status === 400 && /imageConfig|aspect/i.test(txt)) {
      res = await post(false);
      if (!res.ok) txt = await res.text();
    }
    if (!res.ok) throw new Error(apiError(res.status, txt));
  }
  const json = await res.json();
  const cand = json.candidates?.[0];
  const outParts = cand?.content?.parts || [];
  const imgPart = outParts.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!imgPart) {
    const reason = json.promptFeedback?.blockReason || cand?.finishReason || '';
    const said = outParts.map((p) => p.text).filter(Boolean).join(' ').trim();
    throw new Error(`No image came back${reason ? ` (${reason})` : ''}.${said ? ` The model said: ${said.slice(0, 300)}` : ' Try again, or reword your notes.'}`);
  }
  const d = imgPart.inlineData || imgPart.inline_data;
  return `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}`;
}

let busyTimer;
function setBusy(on, text = '') {
  state.busy = on;
  $('#busy').hidden = !on;
  clearInterval(busyTimer);
  if (on) {
    const t0 = Date.now();
    const tick = () => { $('#busyText').textContent = `${text} ${Math.round((Date.now() - t0) / 1000)}s`; };
    tick();
    busyTimer = setInterval(tick, 1000);
  }
  updateRemoveUI(); updateAddUI(); updateFooter();
}

async function generate(parts, label, parentIdx, kind) {
  if (!settings.key) {
    openSettings();
    toast('Add your Gemini API key first.');
    return false;
  }
  const parent = state.versions[parentIdx];
  setBusy(true, kind === 'remove' ? 'Removing furniture…' : 'Placing furniture…');
  try {
    const dataURL = await callGemini(parts, nearestAspect(parent.w, parent.h));
    await addVersion(dataURL, label, parentIdx, { parts, kind, label });
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
    return false;
  } finally {
    setBusy(false);
  }
}

// ---------- versions
async function addVersion(dataURL, label, parent = null, request = null) {
  const img = await loadImage(dataURL);
  state.versions.push({ id: uid(), dataURL, img, w: img.naturalWidth, h: img.naturalHeight, label, parent, request });
  setCurrent(state.versions.length - 1);
}
function setCurrent(i) {
  state.cur = i;
  state.selections = [];
  state.compare = false;
  embedCurrent();
  if (sam.ready && sam.embedded !== cur()?.id) setSamStatus('Analysing photo…');
  updateVersions(); updateRemoveUI(); updateAddUI(); updateFooter(); render();
}
function updateVersions() {
  const box = $('#versions');
  box.innerHTML = '';
  box.hidden = state.versions.length < 2;
  state.versions.forEach((v, i) => {
    const b = document.createElement('button');
    b.className = 'version' + (i === state.cur ? ' active' : '');
    b.title = v.label;
    b.innerHTML = '<img alt=""><span></span>';
    b.querySelector('img').src = v.dataURL;
    b.querySelector('span').textContent = `${i + 1}. ${v.label}`;
    b.onclick = () => { if (!state.busy) setCurrent(i); };
    box.appendChild(b);
  });
  box.lastChild?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function updateFooter() {
  const v = cur();
  const hasParent = v && v.parent != null;
  $('#compareBtn').disabled = !hasParent || state.busy;
  $('#compareBtn').classList.toggle('on', state.compare);
  $('#retryBtn').disabled = !v?.request || state.busy;
  $('#compareBar').hidden = !state.compare;
  canvas.classList.toggle('comparing', state.compare);
}

// ---------- mode + UI wiring
function setMode(m) {
  state.mode = m;
  state.compare = false;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === m));
  $('#removePanel').hidden = m !== 'remove';
  $('#addPanel').hidden = m !== 'add';
  updateAddUI(); updateFooter(); render();
}

async function loadRoom(file) {
  try {
    const raw = await fileToDataURL(file);
    const img0 = await loadImage(raw);
    const dataURL = imageToDataURL(img0, ROOM_MAX);
    state.versions = [];
    state.items.forEach((it) => { it.place = null; });
    $('#drop').hidden = true;
    $('#stageBox').hidden = false;
    $('#panel').hidden = false;
    $('#newPhotoBtn').hidden = false;
    await addVersion(dataURL, 'Original');
    setMode('remove');
    if (!sam.worker && !sam.failed) initSam();
  } catch (err) {
    toast(err.message || String(err), true);
  }
}

function openSettings() {
  const sel = $('#modelSelect');
  if (!sel.options.length) {
    for (const [v, t] of MODEL_OPTIONS) sel.add(new Option(t, v));
    sel.onchange = () => { $('#customModelField').hidden = sel.value !== 'custom'; };
  }
  const m = settings.model;
  const known = MODEL_OPTIONS.some(([v]) => v === m);
  sel.value = known ? m : 'custom';
  $('#customModel').value = known ? '' : m;
  $('#customModelField').hidden = known;
  $('#apiKey').value = settings.key;
  $('#settings').showModal();
}
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  store.set('roomlab.key', $('#apiKey').value.trim());
  const sel = $('#modelSelect').value;
  const model = sel === 'custom' ? $('#customModel').value.trim() : sel;
  if (model) store.set('roomlab.model', model);
  toast('Settings saved.');
});

$('#settingsBtn').onclick = openSettings;
$('#pickRoom').onclick = () => $('#roomInput').click();
$('#newPhotoBtn').onclick = () => $('#roomInput').click();
$('#roomInput').onchange = (e) => { const f = e.target.files[0]; if (f) loadRoom(f); e.target.value = ''; };
$('#addItemBtn').onclick = () => $('#itemInput').click();
$('#itemInput').onchange = (e) => { addItemFiles(e.target.files); e.target.value = ''; };
$('#removeBtn').onclick = runRemove;
$('#addBtn').onclick = runAdd;
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setMode(t.dataset.mode); });

$('#compareBtn').onclick = () => {
  state.compare = !state.compare;
  updateFooter(); render();
};
$('#compareRange').oninput = (e) => { state.compareX = e.target.value / 100; render(); };
$('#retryBtn').onclick = async () => {
  const v = cur();
  if (!v?.request || state.busy) return;
  await generate(v.request.parts, v.request.label, v.parent, v.request.kind);
};
$('#downloadBtn').onclick = () => {
  const v = cur();
  if (!v) return;
  const a = document.createElement('a');
  a.href = v.dataURL;
  const ext = v.dataURL.startsWith('data:image/png') ? 'png' : 'jpg';
  a.download = `room-v${state.cur + 1}.${ext}`;
  a.click();
};

// Canvas pointer handling
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (!cur() || state.busy) return;
  canvas.setPointerCapture(e.pointerId);
  state.drag = { start: toImageCoords(e), box: null, button: e.button };
  if (state.compare) { state.compareX = state.drag.start.x; $('#compareRange').value = state.compareX * 100; render(); }
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.drag) return;
  const p = toImageCoords(e);
  if (state.compare) { state.compareX = p.x; $('#compareRange').value = p.x * 100; render(); return; }
  if (state.mode === 'add' && state.placing) {
    const s = state.drag.start;
    state.drag.box = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    render();
  }
});
canvas.addEventListener('pointerup', (e) => {
  const d = state.drag;
  state.drag = null;
  if (!d || state.busy || state.compare) return;
  const end = toImageCoords(e);
  if (state.mode === 'remove') handleRemoveClick(d.start, { shiftKey: e.shiftKey, altKey: e.altKey, button: d.button });
  else finishPlacement(d.start, end);
});
canvas.addEventListener('pointercancel', () => { state.drag = null; render(); });

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Escape' && state.placing) { state.placing = null; updateAddUI(); render(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && state.mode === 'remove' && state.selections.length) {
    e.preventDefault();
    state.selections.pop();
    render(); updateRemoveUI();
  }
});

// Drag and drop: first photo = room, later drops = furniture.
let dragDepth = 0;
const dropTarget = () => (cur() ? $('#stageBox') : $('#drop'));
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropTarget().classList.add('over'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropTarget().classList.remove('over'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.remove('over'); $('#stageBox').classList.remove('over');
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  if (!cur()) loadRoom(files[0]);
  else addItemFiles(files);
});

// Paste an image: room if none yet, otherwise furniture.
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  if (!cur()) loadRoom(files[0]); else addItemFiles(files);
});

if (!settings.key) setTimeout(openSettings, 300);
