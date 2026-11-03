(() => {
  const $ = (sel, el = document) => el.querySelector(sel);

  const STATUS_JA = {
    'loading tesseract core': 'エンジン読込中',
    'initializing tesseract': 'エンジン初期化中',
    'loading language traineddata': '言語データ読込中',
    'loading language traineddata (from cache)': '言語データ読込中（キャッシュ）',
    'initializing api': 'API 初期化中',
    'recognizing text': '認識中',
  };
  const ENGINE_LABEL = { tesseract: 'Tesseract', vision: 'Cloud Vision' };
  const LANG_LABEL = { 'jpn+eng': '日本語＋英語', jpn: '日本語', 'jpn_vert+jpn': '縦書き', eng: '英語' };
  const BIN_LABEL = { otsu: '二値化:大津', adaptive: '二値化:適応的' };
  const COLOR_LABEL = { white: '白文字抽出', 'white-strict': '白文字抽出(厳しめ)', black: '黒文字抽出' };

  const state = { worker: null, workerLang: null, queue: [], running: false, current: null, items: [], seq: 0, runNo: 0, log: [] };

  // ---------- settings ----------
  function readSettings() {
    return {
      lang: $('#lang').value,
      psm: $('#psm').value,
      whitelist: $('#whitelist').value.trim(),
      colorPick: $('#colorPick').value,
      scale: Number($('#scale').value),
      rotate: Number($('#rotate').value),
      binarize: $('#binarize').value,
      gray: $('#gray').checked,
      contrast: $('#contrast').checked,
      invert: $('#invert').checked,
    };
  }

  const selectedEngines = () => ($('#engine').value === 'both' ? ['tesseract', 'vision'] : [$('#engine').value]);

  function describe(r) {
    const s = r.settings;
    const parts = [];
    if (r.engine === 'tesseract') {
      parts.push(LANG_LABEL[s.lang], `PSM ${s.psm}`);
      if (s.colorPick !== 'none') parts.push(COLOR_LABEL[s.colorPick]);
      if (s.scale !== 1) parts.push(`拡大 ${s.scale}x`);
      if (s.gray) parts.push('グレー');
      if (s.contrast) parts.push('コントラスト補正');
      if (s.binarize !== 'none') parts.push(BIN_LABEL[s.binarize]);
      if (s.invert) parts.push('反転');
      if (s.whitelist) parts.push(`文字限定「${s.whitelist}」`);
    } else {
      parts.push('DOCUMENT_TEXT_DETECTION');
    }
    if (s.rotate) parts.push(`回転 ${s.rotate}°`);
    if (r.region) parts.push('範囲指定');
    return parts;
  }

  // ---------- image preprocessing ----------
  const MAX_SIDE = 3200;
  const PIXEL_OPS_OFF = { scale: 1, colorPick: 'none', gray: false, contrast: false, binarize: 'none', invert: false };

  function preprocess(src, s, region) {
    const r = region || { x: 0, y: 0, w: src.width, h: src.height };
    let w = r.w * s.scale;
    let h = r.h * s.scale;
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    w = Math.round(w * k);
    h = Math.round(h * k);
    const swap = s.rotate % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = swap ? h : w;
    c.height = swap ? w : h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((s.rotate * Math.PI) / 180);
    ctx.drawImage(src, r.x, r.y, r.w, r.h, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const needGray = s.gray || s.contrast || s.binarize !== 'none';
    if (s.colorPick === 'none' && !needGray && !s.invert) return c;

    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const n = c.width * c.height;
    if (s.colorPick !== 'none') {
      extractColor(d, s.colorPick);
    } else if (needGray) {
      let g = new Uint8ClampedArray(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      if (s.contrast) stretchContrast(g);
      if (s.binarize === 'otsu') {
        const t = otsuThreshold(g);
        for (let i = 0; i < n; i++) g[i] = g[i] > t ? 255 : 0;
      } else if (s.binarize === 'adaptive') {
        g = adaptiveThreshold(g, c.width, c.height);
      }
      for (let i = 0, j = 0; i < n; i++, j += 4) d[j] = d[j + 1] = d[j + 2] = g[i];
    }
    if (s.invert) for (let j = 0; j < d.length; j += 4) { d[j] = 255 - d[j]; d[j + 1] = 255 - d[j + 1]; d[j + 2] = 255 - d[j + 2]; }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Keep only bright (or dark) low-saturation pixels as black text on white.
  // Text overlaid on photos is usually pure white with a dark outline or shadow.
  function extractColor(d, mode) {
    for (let j = 0; j < d.length; j += 4) {
      const mx = Math.max(d[j], d[j + 1], d[j + 2]);
      const spread = mx - Math.min(d[j], d[j + 1], d[j + 2]);
      let hit;
      if (mode === 'white') hit = mx >= 225 && spread <= 30;
      else if (mode === 'white-strict') hit = mx >= 240 && spread <= 25;
      else hit = mx <= 80 && spread <= 40;
      d[j] = d[j + 1] = d[j + 2] = hit ? 0 : 255;
    }
  }

  function histogram(g) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    return hist;
  }

  // Stretch the 1st–99th percentile range to 0–255.
  function stretchContrast(g) {
    const hist = histogram(g);
    const cut = g.length * 0.01;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < cut; lo++);
    acc = 0;
    for (; hi > 0 && (acc += hist[hi]) < cut; hi--);
    if (hi - lo < 8) return;
    const scale = 255 / (hi - lo);
    for (let i = 0; i < g.length; i++) g[i] = (g[i] - lo) * scale;
  }

  function otsuThreshold(g) {
    const hist = histogram(g);
    const total = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const diff = sumB / wB - (sum - sumB) / wF;
      const between = wB * wF * diff * diff;
      if (between > best) { best = between; t = i; }
    }
    return t;
  }

  // Bradley–Roth local mean threshold using an integral image.
  function adaptiveThreshold(g, w, h) {
    const W = w + 1;
    const integral = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += g[y * w + x];
        integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + rowSum;
      }
    }
    const r = Math.max(8, Math.round(Math.max(w, h) / 32));
    const out = new Uint8ClampedArray(g.length);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * W + x1 + 1] - integral[y0 * W + x1 + 1] - integral[(y1 + 1) * W + x0] + integral[y0 * W + x0];
        out[y * w + x] = g[y * w + x] * count < sum * 0.85 ? 0 : 255;
      }
    }
    return out;
  }

  // ---------- text helpers ----------
  const JA = '\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff01-\\uff60';
  const JA_GAP = new RegExp(`([${JA}])[ \\t]+(?=[${JA}])`, 'g');

  function displayText(raw) {
    if (!$('#strip').checked) return raw;
    let prev;
    let t = raw;
    do { prev = t; t = t.replace(JA_GAP, '$1'); } while (t !== prev);
    return t;
  }

  const normalize = (t) => t.normalize('NFKC').replace(/\s+/g, '');

  function levenshtein(a, b) {
    const A = [...a], B = [...b];
    if (!A.length) return B.length;
    if (!B.length) return A.length;
    let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
    for (let i = 1; i <= A.length; i++) {
      const cur = [i];
      for (let j = 1; j <= B.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[B.length];
  }

  // Character-level similarity (1 - edit distance / length), ignoring whitespace and width differences.
  function accuracy(expected, actual) {
    const e = normalize(expected), a = normalize(actual);
    if (!e) return null;
    return Math.max(0, 1 - levenshtein(e, a) / Math.max([...e].length, [...a].length));
  }

  const grade = (pct) => (pct >= 80 ? 'good' : pct >= 60 ? 'mid' : 'bad');
  const pctText = (v) => (v == null ? '—' : `${Math.round(v)}%`);

  // ---------- engines ----------
  function onProgress(m) {
    const item = state.current;
    if (!item) return;
    const label = STATUS_JA[m.status] || m.status;
    showProgress(item, label, m.progress ?? 0);
    if (m.status !== 'recognizing text') setStatus(`${label}…（初回は言語データのダウンロードに時間がかかります）`);
  }

  async function getWorker(lang) {
    if (state.worker && state.workerLang === lang) return state.worker;
    if (state.worker) await state.worker.terminate();
    state.worker = null;
    state.workerLang = null;
    state.worker = await Tesseract.createWorker(lang.split('+'), 1, { logger: onProgress });
    state.workerLang = lang;
    return state.worker;
  }

  async function recognizeTesseract(item, s) {
    const worker = await getWorker(s.lang);
    const canvas = preprocess(item.source, s, item.region);
    await worker.setParameters({
      tessedit_pageseg_mode: s.psm,
      tessedit_char_whitelist: s.whitelist,
      preserve_interword_spaces: '1',
    });
    const t0 = performance.now();
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const ms = performance.now() - t0;
    const words = (data.blocks || [])
      .flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
      .map((w) => ({ bbox: w.bbox, confidence: w.confidence }));
    return { text: data.text || '', confidence: data.confidence, ms, words, canvas };
  }

  async function recognizeVision(item, s) {
    showProgress(item, 'Cloud Vision に送信中', null);
    const canvas = preprocess(item.source, { ...s, ...PIXEL_OPS_OFF }, item.region);
    const image = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const t0 = performance.now();
    // server.py relays this to Cloud Vision with the API key, which never reaches the browser.
    const res = await fetch('/api/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    });
    const json = await res.json().catch(() => ({}));
    const ms = performance.now() - t0;
    refreshVisionStatus();
    const err = json.error || json.responses?.[0]?.error;
    if (!res.ok || err) throw new Error(`Cloud Vision: ${err?.message || err || `HTTP ${res.status}`}`);
    const ann = json.responses?.[0]?.fullTextAnnotation;
    const words = (ann?.pages || [])
      .flatMap((p) => p.blocks.flatMap((b) => b.paragraphs.flatMap((pa) => pa.words)))
      .map((w) => {
        const xs = w.boundingBox.vertices.map((v) => v.x ?? 0);
        const ys = w.boundingBox.vertices.map((v) => v.y ?? 0);
        return {
          bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
          confidence: (w.confidence ?? 0) * 100,
        };
      });
    const confidence = words.length ? words.reduce((a, w) => a + w.confidence, 0) / words.length : 0;
    return { text: ann?.text || '', confidence, ms, words, canvas };
  }

  function setStatus(msg) { $('#status').textContent = msg; }

  function showProgress(item, label, value) {
    const bar = item.els.progress.querySelector('progress');
    item.els.progress.hidden = false;
    if (value == null) bar.removeAttribute('value');
    else bar.value = value;
    item.els.progress.querySelector('span').textContent = label;
  }

  // ---------- items & queue ----------
  function addItem({ name, source, expected = '', note = '' }) {
    const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
    const els = {};
    node.querySelectorAll('[data-el]').forEach((el) => { els[el.dataset.el] = el; });
    const item = { id: ++state.seq, name, source, expected, node, els, region: null, results: {}, shown: null, view: 'processed' };
    const radioName = `view-${item.id}`;
    els.viewProcessed.name = radioName;
    els.viewOriginal.name = radioName;
    els.name.textContent = name;
    if (note) { els.note.hidden = false; els.note.textContent = note; }
    els.expected.value = expected;
    if (expected) els.expectedBox.open = true;

    els.expected.addEventListener('input', () => { item.expected = els.expected.value; renderMetrics(item); updateLogAccuracy(item); });
    els.viewProcessed.addEventListener('change', () => setView(item, 'processed'));
    els.viewOriginal.addEventListener('change', () => setView(item, 'original'));
    els.boxes.addEventListener('change', () => drawView(item));
    node.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'rerun') enqueue(item);
      if (act === 'select') startSelect(item);
      if (act === 'unselect') { item.region = null; renderRegionButtons(item); enqueue(item); }
      if (act === 'remove') removeItem(item);
      if (act === 'copy') navigator.clipboard?.writeText(els.text.textContent);
      if (act === 'show') { item.shown = btn.dataset.engine; renderResult(item); }
    });
    bindSelection(item);

    $('#cards').append(node);
    state.items.push(item);
    drawView(item);
    enqueue(item);
    return item;
  }

  function removeItem(item) {
    state.queue = state.queue.filter((job) => job.item !== item);
    state.items = state.items.filter((i) => i !== item);
    item.removed = true;
    item.node.remove();
  }

  function enqueue(item) {
    const settings = readSettings();
    for (const engine of selectedEngines()) {
      if (state.queue.some((job) => job.item === item && job.engine === engine)) continue;
      state.queue.push({ item, engine, settings, region: item.region });
    }
    showProgress(item, '待機中', null);
    pump();
  }

  async function pump() {
    if (state.running) return;
    state.running = true;
    while (state.queue.length) {
      const job = state.queue.shift();
      const { item } = job;
      if (item.removed) continue;
      state.current = item;
      setStatus(`「${item.name}」を ${ENGINE_LABEL[job.engine]} で処理中…（残り ${state.queue.length} 件）`);
      item.els.error.hidden = true;
      try {
        const run = job.engine === 'vision' ? recognizeVision : recognizeTesseract;
        const r = await run(item, job.settings);
        if (!item.removed) {
          item.results[job.engine] = { ...r, engine: job.engine, settings: job.settings, region: job.region };
          item.shown = job.engine;
          setView(item, 'processed');
          renderResult(item);
          appendLog(item, item.results[job.engine]);
        }
      } catch (err) {
        console.error(err);
        item.els.error.hidden = false;
        item.els.error.textContent = `エラー（${ENGINE_LABEL[job.engine]}）: ${err?.message || err}`;
      }
      if (!state.queue.some((q) => q.item === item)) item.els.progress.hidden = true;
    }
    state.current = null;
    state.running = false;
    setStatus(state.items.length ? '完了しました。' : '');
  }

  // ---------- region selection ----------
  function startSelect(item) {
    item.selecting = true;
    setView(item, 'original');
    item.els.view.classList.add('selecting');
    item.els.selhint.hidden = false;
  }

  function stopSelect(item) {
    item.selecting = false;
    item.drag = null;
    item.els.view.classList.remove('selecting');
    item.els.selhint.hidden = true;
    drawView(item);
  }

  function bindSelection(item) {
    const c = item.els.canvas;
    const toSource = (e) => {
      const rect = c.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(c.width, ((e.clientX - rect.left) / rect.width) * c.width)),
        y: Math.max(0, Math.min(c.height, ((e.clientY - rect.top) / rect.height) * c.height)),
      };
    };
    c.addEventListener('pointerdown', (e) => {
      if (!item.selecting) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const p = toSource(e);
      item.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    });
    c.addEventListener('pointermove', (e) => {
      if (!item.selecting || !item.drag) return;
      const p = toSource(e);
      item.drag.x1 = p.x;
      item.drag.y1 = p.y;
      drawView(item);
    });
    c.addEventListener('pointerup', (e) => {
      if (!item.selecting || !item.drag) return;
      const p = toSource(e);
      const { x0, y0 } = item.drag;
      const { x: x1, y: y1 } = p;
      const region = { x: Math.round(Math.min(x0, x1)), y: Math.round(Math.min(y0, y1)), w: Math.round(Math.abs(x1 - x0)), h: Math.round(Math.abs(y1 - y0)) };
      stopSelect(item);
      if (region.w < 10 || region.h < 10) return;
      item.region = region;
      renderRegionButtons(item);
      enqueue(item);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') state.items.filter((i) => i.selecting).forEach(stopSelect);
  });

  function renderRegionButtons(item) {
    item.node.querySelector('[data-act=unselect]').hidden = !item.region;
  }

  // ---------- rendering ----------
  const shownResult = (item) => item.results[item.shown];

  function setView(item, view) {
    item.view = view;
    item.els.viewProcessed.checked = view === 'processed';
    item.els.viewOriginal.checked = view === 'original';
    drawView(item);
  }

  function renderResult(item) {
    const r = shownResult(item);
    if (!r) return;
    const engines = Object.keys(item.results);
    item.els.engines.replaceChildren(...(engines.length > 1 ? engines : []).map((eng) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.dataset.act = 'show';
      b.dataset.engine = eng;
      b.textContent = ENGINE_LABEL[eng];
      b.setAttribute('aria-pressed', String(eng === item.shown));
      return b;
    }));
    const chips = [ENGINE_LABEL[r.engine], ...describe(r)];
    item.els.chips.replaceChildren(...chips.map((t) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = t;
      return c;
    }));
    renderText(item);
    renderMetrics(item);
    drawView(item);
  }

  function renderText(item) {
    const r = shownResult(item);
    if (!r) return;
    const t = displayText(r.text).trim();
    item.els.text.textContent = t || '（文字を検出できませんでした）';
  }

  function setScore(el, value) {
    el.textContent = pctText(value);
    el.className = value == null ? '' : `score ${grade(value)}`;
  }

  const accuracyPct = (item, r) => {
    const acc = accuracy(item.expected, displayText(r.text));
    return acc == null ? null : acc * 100;
  };

  function renderMetrics(item) {
    const r = shownResult(item);
    if (!r) return;
    setScore(item.els.accuracy, accuracyPct(item, r));
    setScore(item.els.confidence, r.confidence);
    item.els.time.textContent = `${(r.ms / 1000).toFixed(1)}s`;
    const low = r.words.filter((w) => w.confidence < 60).length;
    item.els.lowWords.textContent = `${low} / ${r.words.length}`;
  }

  // Only the newest log row per engine tracks edits to the expected text.
  function updateLogAccuracy(item) {
    for (const r of Object.values(item.results)) {
      if (r.logRow) setScore(r.logRow.querySelector('[data-col=acc]'), accuracyPct(item, r));
    }
  }

  const BOX_COLOR = { good: '#2e9e5b', mid: '#d48a14', bad: '#d93a2b' };

  function drawView(item) {
    const c = item.els.canvas;
    const ctx = c.getContext('2d');
    const r = shownResult(item);
    if (item.view === 'original' || !r) {
      c.width = item.source.width;
      c.height = item.source.height;
      ctx.drawImage(item.source, 0, 0);
      ctx.lineWidth = Math.max(2, c.width / 400);
      ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 2]);
      ctx.strokeStyle = '#2f7de1';
      const d = item.drag;
      if (d) ctx.strokeRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
      else if (item.region) ctx.strokeRect(item.region.x, item.region.y, item.region.w, item.region.h);
      return;
    }
    c.width = r.canvas.width;
    c.height = r.canvas.height;
    ctx.drawImage(r.canvas, 0, 0);
    if (!item.els.boxes.checked) return;
    ctx.lineWidth = Math.max(1.5, c.width / 600);
    for (const w of r.words) {
      const { x0, y0, x1, y1 } = w.bbox;
      ctx.strokeStyle = BOX_COLOR[grade(w.confidence)];
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  function appendLog(item, r) {
    const body = $('#logBody');
    if (!state.log.length) body.replaceChildren();
    const no = ++state.runNo;
    const entry = { no, name: item.name, engine: ENGINE_LABEL[r.engine], cond: describe(r).join(' / '), confidence: r.confidence, ms: r.ms, chars: normalize(displayText(r.text)).length };
    state.log.push(entry);

    const tr = document.createElement('tr');
    const cells = [
      ['num', String(no)],
      ['', item.name],
      ['engine', entry.engine],
      ['cond', entry.cond],
      ['num', null, 'acc'],
      ['num', null, 'conf'],
      ['num', `${(r.ms / 1000).toFixed(1)}s`],
      ['num', String(entry.chars)],
    ];
    for (const [cls, text, col] of cells) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      if (text != null) td.textContent = text;
      if (col) {
        const span = document.createElement('span');
        span.dataset.col = col;
        td.append(span);
      }
      tr.append(td);
    }
    setScore(tr.querySelector('[data-col=acc]'), accuracyPct(item, r));
    setScore(tr.querySelector('[data-col=conf]'), r.confidence);
    body.append(tr);
    r.logRow = tr;
    entry.row = tr;
  }

  function logAsTsv() {
    const head = ['#', '画像', 'エンジン', '条件', '一致率', '平均信頼度', '処理時間(s)', '文字数'];
    const rows = state.log.map((e) => [
      e.no, e.name, e.engine, e.cond,
      e.row.querySelector('[data-col=acc]').textContent,
      Math.round(e.confidence), (e.ms / 1000).toFixed(1), e.chars,
    ]);
    return [head, ...rows].map((r) => r.join('\t')).join('\n');
  }

  // ---------- inputs ----------
  async function loadImage(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    }
  }

  async function addFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const source = await loadImage(file);
        addItem({ name: file.name || '貼り付け画像', source });
      } catch (err) {
        setStatus(`${file.name} を読み込めませんでした: ${err.message}`);
      }
    }
  }

  $('#pickFiles').addEventListener('click', () => $('#fileInput').click());
  $('#takePhoto').addEventListener('click', () => $('#cameraInput').click());
  for (const id of ['#fileInput', '#cameraInput']) {
    $(id).addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  }
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });

  $('#rerunAll').addEventListener('click', () => state.items.forEach(enqueue));
  $('#clearAll').addEventListener('click', () => [...state.items].forEach(removeItem));
  $('#strip').addEventListener('change', () => state.items.forEach((i) => { renderText(i); renderMetrics(i); updateLogAccuracy(i); }));
  $('#copyLog').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(logAsTsv());
    setStatus('実行ログを TSV でコピーしました（スプレッドシートに貼り付けできます）。');
  });

  // ---------- Cloud Vision relay ----------
  async function refreshVisionStatus() {
    const el = $('#visionStatus');
    try {
      const res = await fetch('/api/vision/status');
      const { configured, remaining } = await res.json();
      el.textContent = configured
        ? `server.py に API キーが設定されています（このサーバーで残り ${remaining} 件まで）。`
        : 'server.py に API キーが設定されていません。README の手順で .env を作り、サーバーを再起動してください。';
    } catch {
      el.textContent = 'server.py で起動していないため Cloud Vision は使えません（README を参照）。';
    }
  }

  const syncEngine = () => {
    $('#visionBox').hidden = $('#engine').value === 'tesseract';
    if (!$('#visionBox').hidden) refreshVisionStatus();
  };
  $('#engine').addEventListener('change', syncEngine);
  syncEngine();

  // ---------- synthetic samples ----------
  const GOTHIC = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",sans-serif';
  const MINCHO = '"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif';
  const HAND = '"Zen Kurenaido",cursive';
  const MONO = 'Osaka-Mono,"MS Gothic",ui-monospace,monospace';
  const MEMO = ['本日の会議は午後3時から', '第2会議室で行います。', '資料は事前に共有済みです。'];

  function canvas(w, h, bg = '#fff') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    return [c, ctx];
  }

  function writeLines(ctx, lines, { font, size, color = '#111', x = 30, y = 30, lh = 1.6 }) {
    ctx.font = `${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    lines.forEach((t, i) => ctx.fillText(t, x, y + i * size * lh));
  }

  function memo(font, size, opts = {}) {
    const w = Math.round(size * 14 + 60), h = Math.round(size * 1.6 * 3 + 50);
    const [c, ctx] = canvas(w, h, opts.bg);
    writeLines(ctx, MEMO, { font, size, x: 30, y: 25, color: opts.color });
    return c;
  }

  function rotated(src, deg) {
    const rad = (deg * Math.PI) / 180;
    const w = Math.ceil(src.width * Math.cos(rad) + src.height * Math.sin(rad));
    const h = Math.ceil(src.width * Math.sin(rad) + src.height * Math.cos(rad));
    const [c, ctx] = canvas(w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rad);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  // Mimic a phone photo: slight blur, sensor noise and JPEG-ish softness.
  function photoLike(src, blur, noise) {
    const [c, ctx] = canvas(src.width, src.height);
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let j = 0; j < d.length; j += 4) {
      const n = (Math.random() + Math.random() + Math.random() - 1.5) * noise;
      d[j] += n; d[j + 1] += n; d[j + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function unevenLight() {
    const [c, ctx] = canvas(700, 230);
    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#f4f1ea');
    g.addColorStop(0.55, '#b9b4aa');
    g.addColorStop(1, '#4b4741');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    writeLines(ctx, MEMO, { font: GOTHIC, size: 34, x: 30, y: 30, color: '#2a2724' });
    return photoLike(c, 0.6, 14);
  }

  function vertical(cols, size) {
    const colW = size * 1.8;
    const rows = Math.max(...cols.map((t) => [...t].length));
    const [c, ctx] = canvas(Math.round(cols.length * colW + 60), Math.round(rows * size * 1.15 + 60));
    ctx.font = `${size}px ${MINCHO}`;
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    cols.forEach((t, i) => {
      const x = c.width - 30 - colW / 2 - i * colW;
      [...t].forEach((ch, j) => ctx.fillText(ch, x, 30 + j * size * 1.15));
    });
    return c;
  }

  function receipt() {
    const [c, ctx] = canvas(380, 300, '#fbfaf6');
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#222';
    ctx.font = `bold 26px ${GOTHIC}`;
    ctx.textAlign = 'center';
    ctx.fillText('領収書', 190, 22);
    ctx.font = `14px ${MONO}`;
    ctx.fillText('2026/11/03 14:25 No.0042', 190, 62);
    const rows = [['ブレンドコーヒー', '¥480'], ['サンドイッチ', '¥620'], ['小計', '¥1,100'], ['消費税(8%)', '¥88'], ['合計', '¥1,188']];
    ctx.font = `18px ${GOTHIC}`;
    rows.forEach(([l, r], i) => {
      const y = 100 + i * 34;
      ctx.textAlign = 'left';
      ctx.fillText(l, 30, y);
      ctx.textAlign = 'right';
      ctx.fillText(r, 350, y);
    });
    return photoLike(c, 0.4, 10);
  }

  async function buildSamples() {
    await document.fonts.load(`36px "Zen Kurenaido"`, '本日の会議');
    const memoText = MEMO.join('\n');
    return [
      { name: '① くっきり印刷・ゴシック', source: memo(GOTHIC, 34), expected: memoText, note: '基準ケース。これが読めない場合は設定かフォント環境の問題。' },
      { name: '② 明朝体', source: memo(MINCHO, 34), expected: memoText, note: '書籍・公文書によくある書体。' },
      { name: '③ 小さい文字（12px）', source: memo(GOTHIC, 12), expected: memoText, note: '解像度不足のケース。「拡大 2x/3x」で改善するか比べてみてください。' },
      { name: '④ 傾き 8°', source: rotated(memo(GOTHIC, 34), 8), expected: memoText, note: '斜めから撮った写真の想定。' },
      { name: '⑤ 低コントラスト', source: memo(GOTHIC, 34, { bg: '#ebe8e1', color: '#bdb6a9' }), expected: memoText, note: '薄い印字・感熱紙の色あせの想定。「コントラスト自動補正」を試してみてください。' },
      { name: '⑥ 写真風（ぼかし＋ノイズ）', source: photoLike(memo(GOTHIC, 28), 1.6, 40), expected: memoText, note: 'ピンぼけ・暗所ノイズの想定。' },
      { name: '⑦ 照明ムラ・影', source: unevenLight(), expected: memoText, note: '手や影がかかった写真の想定。「二値化：全体」と「適応的」の差が出やすい。' },
      { name: '⑧ 白抜き文字', source: memo(GOTHIC, 34, { bg: '#1d3557', color: '#ffffff' }), expected: memoText, note: '看板・ボタンなど暗い背景に白文字。「色を反転」を試してみてください。' },
      { name: '⑨ 手書き風フォント', source: memo(HAND, 34), expected: memoText, note: '手書き文字の目安（実際の手書きはさらに難しい）。' },
      { name: '⑩ 縦書き', source: vertical(['縦書きの文章を', '正しく読み取れるか', '確認します'], 34), expected: '縦書きの文章を\n正しく読み取れるか\n確認します', note: '言語「日本語 縦書き」＋ PSM 5 で再実行すると差がわかります。' },
      { name: '⑪ レシート風（英数字・記号混在）', source: receipt(), expected: '領収書\n2026/11/03 14:25 No.0042\nブレンドコーヒー ¥480\nサンドイッチ ¥620\n小計 ¥1,100\n消費税(8%) ¥88\n合計 ¥1,188', note: '金額・日付・記号の読み取り精度の確認。' },
      { name: '⑫ 英文（参考）', source: (() => { const [c, ctx] = canvas(720, 140); writeLines(ctx, ['The quick brown fox jumps over', 'the lazy dog. 0123456789'], { font: 'Georgia,serif', size: 34 }); return c; })(), expected: 'The quick brown fox jumps over\nthe lazy dog. 0123456789', note: 'Tesseract が最も得意な英語での比較用。' },
    ];
  }

  $('#runSamples').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      (await buildSamples()).forEach(addItem);
    } finally {
      btn.disabled = false;
    }
  });
})();
