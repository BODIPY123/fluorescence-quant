// ===== 荧光定量分析 - 纯前端实现（含精确选区 + 批量处理 + 细胞计数 + 共定位）=====

// 全局状态
const state = {
  img: null,
  imgData: null,
  scale: 1,
  channel: 'g',
  mode: 'measure',
  regions: [],
  background: null,
  drawing: false,
  startX: 0,
  startY: 0,
  curRect: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('single-mode').hidden = tab !== 'single';
    $('batch-mode').hidden = tab !== 'batch';
    $('cells-mode').hidden = tab !== 'cells';
    $('coloc-mode').hidden = tab !== 'coloc';
    if (tab === 'cells') setupCellCanvas();
    if (tab === 'coloc') setupColocCanvas();
  });
});

function isTiff(file) {
  const name = file.name.toLowerCase();
  return file.type === 'image/tiff' ||
         name.endsWith('.tif') || name.endsWith('.tiff');
}

function decodeFile(file) {
  return new Promise((resolve, reject) => {
    const okType = file.type.startsWith('image/');
    if (!okType && !isTiff(file)) {
      reject(new Error('非图片文件'));
      return;
    }
    if (isTiff(file)) decodeTiff(file, resolve, reject);
    else decodeCommon(file, resolve, reject);
  });
}

function imageToData(img) {
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(img, 0, 0);
  return tctx.getImageData(0, 0, img.width, img.height);
}

function decodeCommon(file, resolve, reject) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      resolve({ img, imgData: imageToData(img), width: img.width, height: img.height });
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = ev.target.result;
  };
  reader.onerror = () => reject(new Error('读取失败'));
  reader.readAsDataURL(file);
}

function decodeTiff(file, resolve, reject) {
  if (typeof UTIF === 'undefined') {
    reject(new Error('TIFF 解码库未加载（首次需联网）'));
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const buf = ev.target.result;
      const ifds = UTIF.decode(buf);
      if (!ifds.length) throw new Error('空 TIFF');
      const page = ifds[0];
      UTIF.decodeImage(buf, page);
      const rgba = UTIF.toRGBA8(page);
      const w = page.width, h = page.height;

      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tctx = tmp.getContext('2d');
      const imgData = tctx.createImageData(w, h);
      imgData.data.set(rgba);
      tctx.putImageData(imgData, 0, 0);

      const img = new Image();
      img.onload = () => resolve({ img, imgData, width: w, height: h });
      img.src = tmp.toDataURL();
    } catch (err) {
      reject(err);
    }
  };
  reader.onerror = () => reject(new Error('读取失败'));
  reader.readAsArrayBuffer(file);
}

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const uploadPanel = $('upload-panel');
const workspace = $('workspace');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) loadSingle(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) loadSingle(e.target.files[0]);
});

function loadSingle(file) {
  decodeFile(file)
    .then(({ img, imgData }) => {
      state.img = img;
      state.imgData = imgData;
      setupCanvas(img);
      uploadPanel.hidden = true;
      workspace.hidden = false;
    })
    .catch((err) => alert('加载失败：' + err.message));
}

function setupCanvas(img) {
  const maxW = 900;
  state.scale = img.width > maxW ? maxW / img.width : 1;
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.style.width = (img.width * state.scale) + 'px';
  canvas.style.height = (img.height * state.scale) + 'px';
  ctx.drawImage(img, 0, 0);

  state.regions = [];
  state.background = null;
  redraw();
  renderResults();
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / state.scale;
  const y = (e.clientY - rect.top) / state.scale;
  return {
    x: Math.max(0, Math.min(canvas.width, x)),
    y: Math.max(0, Math.min(canvas.height, y)),
  };
}

function clampRect(r) {
  let x = Math.max(0, Math.min(r.x, canvas.width));
  let y = Math.max(0, Math.min(r.y, canvas.height));
  let w = Math.min(r.w, canvas.width - x);
  let h = Math.min(r.h, canvas.height - y);
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function addRect(r) {
  if (state.mode === 'measure') {
    state.regions.push(r);
  } else {
    r.mean = measureRegion(r, state.imgData, state.channel).mean;
    state.background = r;
  }
  redraw();
  renderResults();
}

canvas.addEventListener('mousedown', (e) => {
  const p = getPos(e);
  if ($('fixedSizeMode').checked) {
    const w = Math.max(1, +$('fw').value || 50);
    const h = Math.max(1, +$('fh').value || 50);
    addRect(clampRect({ x: p.x - w / 2, y: p.y - h / 2, w, h }));
    return;
  }
  state.drawing = true;
  state.startX = p.x;
  state.startY = p.y;
  state.curRect = { x: p.x, y: p.y, w: 0, h: 0 };
});

canvas.addEventListener('mousemove', (e) => {
  if (!state.drawing) return;
  const p = getPos(e);
  state.curRect = {
    x: Math.min(state.startX, p.x),
    y: Math.min(state.startY, p.y),
    w: Math.abs(p.x - state.startX),
    h: Math.abs(p.y - state.startY),
  };
  redraw();
});

canvas.addEventListener('mouseup', () => {
  if (!state.drawing) return;
  state.drawing = false;
  const r = state.curRect;
  state.curRect = null;
  if (!r || r.w < 3 || r.h < 3) { redraw(); return; }
  addRect(clampRect(r));
});

$('addFixedMeasure').addEventListener('click', () => addFixed('measure'));
$('addFixedBg').addEventListener('click', () => addFixed('background'));

function addFixed(kind) {
  if (!state.imgData) { alert('请先加载一张图片'); return; }
  const x = +$('fx').value, y = +$('fy').value;
  const w = +$('fw').value, h = +$('fh').value;
  if ([x, y, w, h].some((n) => Number.isNaN(n)) || w <= 0 || h <= 0) {
    alert('请填写有效的 X / Y / 宽 / 高');
    return;
  }
  const r = clampRect({ x, y, w, h });
  if (kind === 'measure') {
    state.regions.push(r);
  } else {
    r.mean = measureRegion(r, state.imgData, state.channel).mean;
    state.background = r;
  }
  redraw();
  renderResults();
}

function channelValueAt(data, i, channel) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  switch (channel) {
    case 'r': return r;
    case 'g': return g;
    case 'b': return b;
    default:  return 0.299 * r + 0.587 * g + 0.114 * b;
  }
}

function measureRegion(rect, imgData, channel) {
  const { data, width, height } = imgData;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(width, Math.round(rect.x + rect.w));
  const y1 = Math.min(height, Math.round(rect.y + rect.h));

  let sum = 0, count = 0, min = Infinity, max = -Infinity;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const v = channelValueAt(data, i, channel);
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      count++;
    }
  }
  const mean = count ? sum / count : 0;
  return { area: count, mean, min: count ? min : 0, max: count ? max : 0, intDen: sum };
}

function redraw() {
  if (!state.img) return;
  ctx.drawImage(state.img, 0, 0);
  if (state.background) drawRect(state.background, '#c0562f', 'BG');
  state.regions.forEach((r, i) => drawRect(r, '#2f7d63', String(i + 1)));
  if (state.curRect) {
    drawRect(state.curRect, state.mode === 'measure' ? '#2f7d63' : '#c0562f', '');
  }
}

function drawRect(r, color, label) {
  ctx.save();
  ctx.lineWidth = Math.max(1.5, 2 / state.scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color + '22';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  if (label) {
    const fs = Math.max(12, 14 / state.scale);
    ctx.font = `600 ${fs}px sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(label, r.x + 4 / state.scale, r.y + fs);
  }
  ctx.restore();
}

function renderResults() {
  const body = $('resultBody');
  const bgInfo = $('bgInfo');
  if (state.background) {
    bgInfo.textContent = `背景平均强度：${state.background.mean.toFixed(2)}（结果已做背景扣除 CTCF）`;
    bgInfo.classList.add('active');
  } else {
    bgInfo.textContent = '背景：未设置（结果未做背景扣除）';
    bgInfo.classList.remove('active');
  }

  body.innerHTML = '';
  if (!state.regions.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="8">框选或输入坐标添加测量区</td></tr>';
    return;
  }
  const bgMean = state.background ? state.background.mean : null;
  state.regions.forEach((r, idx) => {
    const m = measureRegion(r, state.imgData, state.channel);
    const ctcf = bgMean !== null ? m.intDen - m.area * bgMean : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${Math.round(r.x)},${Math.round(r.y)} · ${Math.round(r.w)}×${Math.round(r.h)}</td>
      <td>${m.area}</td>
      <td>${m.mean.toFixed(2)}</td>
      <td>${m.min.toFixed(0)}</td>
      <td>${m.max.toFixed(0)}</td>
      <td>${m.intDen.toFixed(0)}</td>
      <td>${ctcf !== null ? ctcf.toFixed(0) : '—'}</td>`;
    body.appendChild(tr);
  });
}

$('channelSelect').addEventListener('change', (e) => {
  state.channel = e.target.value;
  if (state.background) {
    state.background.mean = measureRegion(state.background, state.imgData, state.channel).mean;
  }
  renderResults();
});

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
  });
});

$('undoBtn').addEventListener('click', () => {
  if (state.mode === 'background') state.background = null;
  else if (state.regions.length) state.regions.pop();
  redraw();
  renderResults();
});

$('clearBtn').addEventListener('click', () => {
  state.regions = [];
  state.background = null;
  redraw();
  renderResults();
});

$('newImageBtn').addEventListener('click', () => {
  workspace.hidden = true;
  uploadPanel.hidden = false;
  fileInput.value = '';
});

$('exportBtn').addEventListener('click', () => {
  if (!state.regions.length) { alert('暂无测量数据'); return; }
  const bgMean = state.background ? state.background.mean : null;
  let csv = '编号,X,Y,宽,高,面积,平均强度,最小,最大,积分密度,背景校正CTCF\n';
  state.regions.forEach((r, idx) => {
    const m = measureRegion(r, state.imgData, state.channel);
    const ctcf = bgMean !== null ? (m.intDen - m.area * bgMean).toFixed(0) : '';
    csv += `${idx + 1},${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)},${m.area},${m.mean.toFixed(2)},${m.min.toFixed(0)},${m.max.toFixed(0)},${m.intDen.toFixed(0)},${ctcf}\n`;
  });
  downloadCsv(csv, '荧光定量结果.csv');
});

let batchFiles = [];
let batchResults = [];

const batchInput = $('batchInput');
const batchDrop = $('batchDrop');

batchDrop.addEventListener('click', () => batchInput.click());
batchDrop.addEventListener('dragover', (e) => { e.preventDefault(); batchDrop.classList.add('dragover'); });
batchDrop.addEventListener('dragleave', () => batchDrop.classList.remove('dragover'));
batchDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  batchDrop.classList.remove('dragover');
  addBatchFiles(e.dataTransfer.files);
});
batchInput.addEventListener('change', (e) => addBatchFiles(e.target.files));

function addBatchFiles(fileList) {
  for (const f of fileList) {
    if (f.type.startsWith('image/') || isTiff(f)) batchFiles.push(f);
  }
  renderBatchFileList();
}

function renderBatchFileList() {
  const el = $('batchFileList');
  if (!batchFiles.length) {
    el.innerHTML = '<p class="muted-text">尚未添加图片</p>';
    return;
  }
  el.innerHTML = `<p class="muted-text">已添加 ${batchFiles.length} 张图片：</p>` +
    '<ul>' + batchFiles.map((f) => `<li>${f.name}</li>`).join('') + '</ul>';
}

$('batchClearFiles').addEventListener('click', () => {
  batchFiles = [];
  renderBatchFileList();
});

function updateRoiSummary() {
  const el = $('roiSummary');
  if (!state.regions.length) {
    el.innerHTML = '<span class="warn">尚未定义测量区。</span>请先到「单图分析」加载一张代表图，框选或输入测量区（和背景区），这套选区会应用到批量的每张图。';
  } else {
    el.innerHTML = `已定义 <b>${state.regions.length}</b> 个测量区` +
      (state.background ? '，含背景区（将做 CTCF 背景扣除）' : '，无背景区') +
      '。批量处理会在每张图的相同坐标上测量。';
  }
}

document.querySelector('.tab-btn[data-tab="batch"]').addEventListener('click', updateRoiSummary);

$('runBatch').addEventListener('click', async () => {
  if (!batchFiles.length) { alert('请先添加图片'); return; }
  if (!state.regions.length) { alert('请先在「单图分析」里定义测量区'); return; }

  const channel = state.channel;
  const bgRect = state.background;
  const progress = $('batchProgress');
  const runBtn = $('runBatch');
  runBtn.disabled = true;
  batchResults = [];

  for (let i = 0; i < batchFiles.length; i++) {
    const file = batchFiles[i];
    progress.textContent = `处理中 ${i + 1}/${batchFiles.length}：${file.name}`;
    try {
      const { imgData } = await decodeFile(file);
      let bgMean = null;
      if (bgRect) bgMean = measureRegion(bgRect, imgData, channel).mean;

      state.regions.forEach((r, idx) => {
        const m = measureRegion(r, imgData, channel);
        const ctcf = bgMean !== null ? m.intDen - m.area * bgMean : null;
        batchResults.push({
          file: file.name,
          roi: idx + 1,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.w), h: Math.round(r.h),
          area: m.area, mean: m.mean, min: m.min, max: m.max,
          intDen: m.intDen, bgMean, ctcf,
        });
      });
    } catch (err) {
      batchResults.push({ file: file.name, roi: '-', error: err.message });
    }
  }

  progress.textContent = `完成，共 ${batchFiles.length} 张图、${batchResults.length} 条记录。`;
  runBtn.disabled = false;
  renderBatchResults();
});

function renderBatchResults() {
  const body = $('batchResultBody');
  body.innerHTML = '';
  if (!batchResults.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="9">运行后显示结果</td></tr>';
    return;
  }
  batchResults.forEach((r) => {
    const tr = document.createElement('tr');
    if (r.error) {
      tr.innerHTML = `<td>${r.file}</td><td colspan="8" class="warn">解码失败：${r.error}</td>`;
    } else {
      tr.innerHTML = `
        <td>${r.file}</td>
        <td>${r.roi}</td>
        <td>${r.x},${r.y} · ${r.w}×${r.h}</td>
        <td>${r.area}</td>
        <td>${r.mean.toFixed(2)}</td>
        <td>${r.min.toFixed(0)}</td>
        <td>${r.max.toFixed(0)}</td>
        <td>${r.intDen.toFixed(0)}</td>
        <td>${r.ctcf !== null ? r.ctcf.toFixed(0) : '—'}</td>`;
    }
    body.appendChild(tr);
  });
}

$('batchExport').addEventListener('click', () => {
  if (!batchResults.length) { alert('暂无批量结果'); return; }
  let csv = '文件名,测量区,X,Y,宽,高,面积,平均强度,最小,最大,积分密度,背景均值,背景校正CTCF\n';
  batchResults.forEach((r) => {
    if (r.error) {
      csv += `${r.file},解码失败,,,,,,,,,,,\n`;
    } else {
      csv += `${r.file},${r.roi},${r.x},${r.y},${r.w},${r.h},${r.area},${r.mean.toFixed(2)},${r.min.toFixed(0)},${r.max.toFixed(0)},${r.intDen.toFixed(0)},${r.bgMean !== null ? r.bgMean.toFixed(2) : ''},${r.ctcf !== null ? r.ctcf.toFixed(0) : ''}\n`;
    }
  });
  downloadCsv(csv, '荧光定量_批量结果.csv');
});

function downloadCsv(csv, filename) {
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const cellCanvas = $('cellCanvas');
const cellCtx = cellCanvas.getContext('2d');
let cellScale = 1;
let lastCells = [];

function setupCellCanvas() {
  const info = $('cellNoImage');
  if (!state.img) {
    cellCanvas.hidden = true;
    info.hidden = false;
    return;
  }
  info.hidden = true;
  cellCanvas.hidden = false;
  const maxW = 900;
  cellScale = state.img.width > maxW ? maxW / state.img.width : 1;
  cellCanvas.width = state.img.width;
  cellCanvas.height = state.img.height;
  cellCanvas.style.width = (state.img.width * cellScale) + 'px';
  cellCanvas.style.height = (state.img.height * cellScale) + 'px';
  cellCtx.drawImage(state.img, 0, 0);
}

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = i; }
  }
  return threshold;
}

function dilate(src, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (src[p]) { out[p] = 1; continue; }
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (src[ny * w + nx]) { on = 1; break; }
        }
      }
      out[p] = on;
    }
  }
  return out;
}

function fillHoles(src, w, h) {
  const n = w * h;
  const bgReach = new Uint8Array(n);
  const stack = [];
  const tryPush = (p) => {
    if (p >= 0 && p < n && !src[p] && !bgReach[p]) { bgReach[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p - x) / w;
    if (x > 0) tryPush(p - 1);
    if (x < w - 1) tryPush(p + 1);
    if (y > 0) tryPush(p - w);
    if (y < h - 1) tryPush(p + w);
  }
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = (src[p] || !bgReach[p]) ? 1 : 0;
  return out;
}

function labelAndFilter(bin, w, h, opts) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const cells = [];
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (!bin[s] || seen[s]) continue;
    let area = 0, sumx = 0, sumy = 0;
    let minx = w, miny = h, maxx = 0, maxy = 0;
    seen[s] = 1; stack.length = 0; stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      area++; sumx += x; sumy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (bin[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    if (area < opts.minArea || area > opts.maxArea) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    const aspect = Math.min(bw, bh) / Math.max(bw, bh);
    const fill = area / (bw * bh);
    if (opts.roundness && (aspect < opts.minAspect || fill < opts.minFill)) continue;
    cells.push({ cx: sumx / area, cy: sumy / area, area, r: Math.sqrt(area / Math.PI) });
  }
  return cells;
}

function detectCells(imgData, channel, opts) {
  const { data, width, height } = imgData;
  const n = width * height;
  const intensity = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = Math.round(channelValueAt(data, i, channel));
    intensity[p] = v;
    hist[v]++;
  }
  let th = opts.threshold;
  if (opts.auto) th = otsuThreshold(hist, n);

  const fg = new Uint8Array(n);
  for (let p = 0; p < n; p++) fg[p] = intensity[p] >= th ? 1 : 0;

  let cur = fg;
  for (let it = 0; it < opts.close; it++) cur = dilate(cur, width, height);

  const filled = fillHoles(cur, width, height);
  const cells = labelAndFilter(filled, width, height, opts);
  return { threshold: th, cells };
}

function drawCells(cells) {
  cellCtx.drawImage(state.img, 0, 0);
  cellCtx.save();
  cellCtx.lineWidth = Math.max(1.5, 2 / cellScale);
  cellCtx.strokeStyle = '#f5b301';
  cellCtx.fillStyle = '#f5b301';
  cells.forEach((c) => {
    cellCtx.beginPath();
    cellCtx.arc(c.cx, c.cy, Math.max(c.r, 3), 0, Math.PI * 2);
    cellCtx.stroke();
    cellCtx.beginPath();
    cellCtx.arc(c.cx, c.cy, Math.max(2, 2 / cellScale), 0, Math.PI * 2);
    cellCtx.fill();
  });
  cellCtx.restore();
}

let cvReady = false;
function checkCv() {
  if (typeof cv !== 'undefined' && cv.Mat) {
    cvReady = true;
    updateCvStatus();
  } else {
    setTimeout(checkCv, 300);
  }
}
checkCv();

function updateCvStatus() {
  const el = $('cellOpencvStatus');
  if (!el) return;
  if ($('cellMethod').value !== 'hough') { el.textContent = ''; return; }
  el.textContent = cvReady
    ? 'OpenCV 已就绪。'
    : 'OpenCV 加载中…（首次需联网，请稍候再点开始计数）';
}

function grayFromChannel(imgData, channel) {
  const { data, width, height } = imgData;
  const n = width * height;
  const gray = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    gray[p] = Math.round(channelValueAt(data, i, channel));
  }
  return { gray, width, height };
}

function detectCellsHough(imgData, channel, opts) {
  const { gray, width, height } = grayFromChannel(imgData, channel);
  const src = cv.matFromArray(height, width, cv.CV_8UC1, gray);
  const blurred = new cv.Mat();
  let k = Math.max(1, opts.blur | 0);
  if (k % 2 === 0) k += 1;
  cv.GaussianBlur(src, blurred, new cv.Size(k, k), 0, 0, cv.BORDER_DEFAULT);

  const circles = new cv.Mat();
  cv.HoughCircles(
    blurred, circles, cv.HOUGH_GRADIENT,
    1, opts.minDist, opts.param1, opts.param2, opts.minR, opts.maxR
  );

  const cells = [];
  for (let i = 0; i < circles.cols; i++) {
    const cx = circles.data32F[i * 3];
    const cy = circles.data32F[i * 3 + 1];
    const r = circles.data32F[i * 3 + 2];
    cells.push({ cx, cy, r, area: Math.PI * r * r });
  }

  src.delete();
  blurred.delete();
  circles.delete();
  return cells;
}

function applyMethodVisibility() {
  const m = $('cellMethod').value;
  document.querySelectorAll('.method-hough').forEach((el) => { el.hidden = m !== 'hough'; });
  document.querySelectorAll('.method-contour').forEach((el) => { el.hidden = m !== 'contour'; });
  updateCvStatus();
}
$('cellMethod').addEventListener('change', applyMethodVisibility);
applyMethodVisibility();

$('cellAuto').addEventListener('change', (e) => {
  $('cellThreshold').disabled = e.target.checked;
});
$('cellThreshold').addEventListener('input', (e) => {
  $('cellThVal').textContent = e.target.value;
});

$('runCellCount').addEventListener('click', () => {
  if (!state.imgData) { alert('请先在「单图分析」加载一张图片'); return; }
  setupCellCanvas();
  const method = $('cellMethod').value;
  const channel = $('cellChannel').value;

  if (method === 'hough') {
    if (!cvReady) { alert('OpenCV 还在加载中，请稍候再试（首次需联网）'); return; }
    const opts = {
      minR: Math.max(0, +$('houghMinR').value || 0),
      maxR: Math.max(0, +$('houghMaxR').value || 0),
      minDist: Math.max(1, +$('houghMinDist').value || 20),
      param1: Math.max(1, +$('houghParam1').value || 100),
      param2: Math.max(1, +$('houghParam2').value || 30),
      blur: Math.max(1, +$('houghBlur').value || 3),
    };
    try {
      const cells = detectCellsHough(state.imgData, channel, opts);
      lastCells = cells;
      drawCells(cells);
      $('cellResult').innerHTML = `检测到约 <b>${cells.length}</b> 个细胞（霍夫圆检测）。`;
      $('cellResult').classList.add('active');
    } catch (err) {
      alert('霍夫圆检测出错：' + err.message);
    }
    return;
  }

  const opts = {
    auto: $('cellAuto').checked,
    threshold: +$('cellThreshold').value,
    minArea: +$('cellMinArea').value,
    maxArea: +$('cellMaxArea').value,
    close: Math.max(0, Math.min(3, +$('cellClose').value || 0)),
    roundness: $('cellRoundness').checked,
    minAspect: 0.55,
    minFill: 0.45,
  };
  const { threshold, cells } = detectCells(state.imgData, channel, opts);
  lastCells = cells;
  drawCells(cells);
  $('cellResult').innerHTML =
    `检测到约 <b>${cells.length}</b> 个细胞（连通域）。` +
    (opts.auto ? `（自动阈值 ${threshold}）` : '');
  $('cellResult').classList.add('active');
});

$('cellExport').addEventListener('click', () => {
  if (!lastCells.length) { alert('暂无细胞数据，请先运行'); return; }
  let csv = '编号,中心X,中心Y,面积,等效半径\n';
  lastCells.forEach((c, i) => {
    csv += `${i + 1},${c.cx.toFixed(1)},${c.cy.toFixed(1)},${c.area.toFixed(0)},${c.r.toFixed(1)}\n`;
  });
  downloadCsv(csv, '细胞计数结果.csv');
});
// ====================================================
//  双通道共定位分析（划线剖面 + 整图 Pearson/Manders）
// ====================================================
const colocCanvas = $('colocCanvas');
const colocCtx = colocCanvas.getContext('2d');
const scatterCanvas = $('scatterCanvas');
const scatterCtx = scatterCanvas.getContext('2d');
let colocScale = 1;
let colocLineSeg = null;    // 当前划线 {x0,y0,x1,y1}
let colocDrawing = false;
let lastColoc = null;       // 整图结果
let lastLine = null;        // 划线结果

function setupColocCanvas() {
  const info = $('colocNoImage');
  if (!state.img) {
    colocCanvas.hidden = true;
    info.hidden = false;
    return;
  }
  info.hidden = true;
  colocCanvas.hidden = false;
  const maxW = 900;
  colocScale = state.img.width > maxW ? maxW / state.img.width : 1;
  colocCanvas.width = state.img.width;
  colocCanvas.height = state.img.height;
  colocCanvas.style.width = (state.img.width * colocScale) + 'px';
  colocCanvas.style.height = (state.img.height * colocScale) + 'px';
  colocLineSeg = null;
  drawColoc();
}

function drawColoc() {
  if (!state.img) return;
  colocCtx.drawImage(state.img, 0, 0);
  if (colocLineSeg) {
    const L = colocLineSeg;
    colocCtx.save();
    colocCtx.lineWidth = Math.max(2, 2.5 / colocScale);
    colocCtx.strokeStyle = '#f5b301';
    colocCtx.beginPath();
    colocCtx.moveTo(L.x0, L.y0);
    colocCtx.lineTo(L.x1, L.y1);
    colocCtx.stroke();
    colocCtx.fillStyle = '#f5b301';
    [[L.x0, L.y0], [L.x1, L.y1]].forEach(([px, py]) => {
      colocCtx.beginPath();
      colocCtx.arc(px, py, Math.max(3, 3 / colocScale), 0, Math.PI * 2);
      colocCtx.fill();
    });
    colocCtx.restore();
  }
}

function colocPos(e) {
  const rect = colocCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(colocCanvas.width, (e.clientX - rect.left) / colocScale)),
    y: Math.max(0, Math.min(colocCanvas.height, (e.clientY - rect.top) / colocScale)),
  };
}

colocCanvas.addEventListener('mousedown', (e) => {
  const p = colocPos(e);
  colocDrawing = true;
  colocLineSeg = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});
colocCanvas.addEventListener('mousemove', (e) => {
  if (!colocDrawing) return;
  const p = colocPos(e);
  colocLineSeg.x1 = p.x;
  colocLineSeg.y1 = p.y;
  drawColoc();
});
colocCanvas.addEventListener('mouseup', () => {
  if (!colocDrawing) return;
  colocDrawing = false;
  if (colocLineSeg) {
    const len = Math.hypot(colocLineSeg.x1 - colocLineSeg.x0, colocLineSeg.y1 - colocLineSeg.y0);
    if (len < 3) colocLineSeg = null;
  }
  drawColoc();
});

function sampleLine(imgData, chA, chB, line, lw) {
  const { data, width, height } = imgData;
  const dx = line.x1 - line.x0, dy = line.y1 - line.y0;
  const len = Math.round(Math.hypot(dx, dy));
  const nx = len === 0 ? 0 : -dy / len;
  const ny = len === 0 ? 0 : dx / len;
  const half = Math.floor(Math.max(1, lw) / 2);

  const samples = [];
  for (let i = 0; i <= len; i++) {
    const t = len === 0 ? 0 : i / len;
    const bx = line.x0 + dx * t;
    const by = line.y0 + dy * t;
    let sa = 0, sb = 0, cnt = 0;
    for (let w = -half; w <= half; w++) {
      const x = Math.round(bx + nx * w);
      const y = Math.round(by + ny * w);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const idx = (y * width + x) * 4;
      sa += channelValueAt(data, idx, chA);
      sb += channelValueAt(data, idx, chB);
      cnt++;
    }
    if (cnt) samples.push({ d: i, a: sa / cnt, b: sb / cnt });
  }
  return samples;
}

function pearsonOf(samples) {
  const n = samples.length;
  if (n < 2) return 0;
  let mA = 0, mB = 0;
  samples.forEach((s) => { mA += s.a; mB += s.b; });
  mA /= n; mB /= n;
  let cov = 0, vA = 0, vB = 0;
  samples.forEach((s) => {
    const da = s.a - mA, db = s.b - mB;
    cov += da * db; vA += da * da; vB += db * db;
  });
  return (vA > 0 && vB > 0) ? cov / Math.sqrt(vA * vB) : 0;
}

function computeColoc(imgData, chA, chB, thA, thB) {
  const { data, width, height } = imgData;
  const total = width * height;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < total * 4; i += 4) {
    sumA += channelValueAt(data, i, chA);
    sumB += channelValueAt(data, i, chB);
  }
  const meanA = sumA / total, meanB = sumB / total;

  let cov = 0, varA = 0, varB = 0;
  let mSumA = 0, mSumAcoloc = 0, mSumB = 0, mSumBcoloc = 0;
  const sample = [];
  const step = Math.max(1, Math.floor(total / 6000));
  let idx = 0;
  for (let i = 0; i < total * 4; i += 4) {
    const a = channelValueAt(data, i, chA);
    const b = channelValueAt(data, i, chB);
    const da = a - meanA, db = b - meanB;
    cov += da * db; varA += da * da; varB += db * db;
    mSumA += a; if (b > thB) mSumAcoloc += a;
    mSumB += b; if (a > thA) mSumBcoloc += b;
    if (idx % step === 0) sample.push([a, b]);
    idx++;
  }
  const pearson = (varA > 0 && varB > 0) ? cov / Math.sqrt(varA * varB) : 0;
  const m1 = mSumA > 0 ? mSumAcoloc / mSumA : 0;
  const m2 = mSumB > 0 ? mSumBcoloc / mSumB : 0;
  return { pearson, m1, m2, n: total, sample, chA, chB };
}

const CH_COLOR = { r: '#d64550', g: '#2f9e44', b: '#3b6fd6', gray: '#555' };
const CH_NAME = { r: '红 R', g: '绿 G', b: '蓝 B', gray: '灰度' };

function drawProfile(samples, chA, chB) {
  const W = scatterCanvas.width, H = scatterCanvas.height;
  scatterCtx.clearRect(0, 0, W, H);
  scatterCtx.fillStyle = '#fafbfc';
  scatterCtx.fillRect(0, 0, W, H);

  const padL = 34, padB = 24, padT = 10, padR = 8;
  const plotW = W - padL - padR, plotH = H - padB - padT;

  scatterCtx.strokeStyle = '#c9ced4';
  scatterCtx.lineWidth = 1;
  scatterCtx.beginPath();
  scatterCtx.moveTo(padL, padT);
  scatterCtx.lineTo(padL, H - padB);
  scatterCtx.lineTo(W - padR, H - padB);
  scatterCtx.stroke();
  scatterCtx.fillStyle = '#6b7280';
  scatterCtx.font = '10px sans-serif';
  scatterCtx.fillText('255', 4, padT + 8);
  scatterCtx.fillText('0', 16, H - padB);
  scatterCtx.fillText('沿线距离（像素）', padL + 20, H - 6);

  if (samples.length < 2) return;
  const maxD = samples[samples.length - 1].d || 1;

  const plot = (key, color) => {
    scatterCtx.strokeStyle = color;
    scatterCtx.lineWidth = 1.5;
    scatterCtx.beginPath();
    samples.forEach((s, i) => {
      const px = padL + (s.d / maxD) * plotW;
      const py = (H - padB) - (s[key] / 255) * plotH;
      if (i === 0) scatterCtx.moveTo(px, py);
      else scatterCtx.lineTo(px, py);
    });
    scatterCtx.stroke();
  };
  plot('a', CH_COLOR[chA]);
  plot('b', CH_COLOR[chB]);

  scatterCtx.font = '10px sans-serif';
  scatterCtx.fillStyle = CH_COLOR[chA];
  scatterCtx.fillText('— 通道A ' + CH_NAME[chA], padL + 6, padT + 10);
  scatterCtx.fillStyle = CH_COLOR[chB];
  scatterCtx.fillText('— 通道B ' + CH_NAME[chB], padL + 6, padT + 22);
}

function drawScatter(res) {
  const W = scatterCanvas.width, H = scatterCanvas.height;
  scatterCtx.clearRect(0, 0, W, H);
  scatterCtx.fillStyle = '#fafbfc';
  scatterCtx.fillRect(0, 0, W, H);
  const pad = 30;
  scatterCtx.strokeStyle = '#c9ced4';
  scatterCtx.lineWidth = 1;
  scatterCtx.beginPath();
  scatterCtx.moveTo(pad, H - pad);
  scatterCtx.lineTo(W - 5, H - pad);
  scatterCtx.moveTo(pad, H - pad);
  scatterCtx.lineTo(pad, 5);
  scatterCtx.stroke();
  scatterCtx.fillStyle = '#6b7280';
  scatterCtx.font = '11px sans-serif';
  scatterCtx.fillText('通道A →', W / 2 - 20, H - 8);
  scatterCtx.save();
  scatterCtx.translate(10, H / 2 + 20);
  scatterCtx.rotate(-Math.PI / 2);
  scatterCtx.fillText('通道B →', 0, 0);
  scatterCtx.restore();
  const plotW = W - pad - 8, plotH = H - pad - 8;
  scatterCtx.fillStyle = 'rgba(47,125,99,0.45)';
  res.sample.forEach(([a, b]) => {
    const px = pad + (a / 255) * plotW;
    const py = (H - pad) - (b / 255) * plotH;
    scatterCtx.fillRect(px, py, 2, 2);
  });
}

function pearsonWord(r) {
  const v = Math.abs(r);
  if (v >= 0.7) return '强相关';
  if (v >= 0.5) return '中等相关';
  if (v >= 0.3) return '弱相关';
  return '几乎无相关';
}

$('colocWhole').addEventListener('click', () => {
  if (!state.imgData) { alert('请先在「单图分析」加载一张图片'); return; }
  const chA = $('colocChA').value, chB = $('colocChB').value;
  const thA = +$('colocThA').value || 0, thB = +$('colocThB').value || 0;
  const res = computeColoc(state.imgData, chA, chB, thA, thB);
  lastColoc = { ...res, scope: '整图' };
  lastLine = null;
  const sign = res.pearson < -0.1 ? '（负相关，倾向互斥）' : '';
  $('colocResult').innerHTML =
    `<b>整图</b>（像素数 ${res.n}）<br>` +
    `Pearson 系数 r = <b>${res.pearson.toFixed(3)}</b> — ${pearsonWord(res.pearson)}${sign}<br>` +
    `Manders M1 = <b>${res.m1.toFixed(3)}</b>（通道A 与 B 重叠的比例）<br>` +
    `Manders M2 = <b>${res.m2.toFixed(3)}</b>（通道B 与 A 重叠的比例）`;
  $('colocResult').classList.add('active');
  $('chartTitle').textContent = '双通道散点图';
  $('chartHint').textContent = '点沿对角线聚集 = 共定位强；分散或贴轴 = 共定位弱';
  drawScatter(res);
});

$('colocLine').addEventListener('click', () => {
  if (!state.imgData) { alert('请先在「单图分析」加载一张图片'); return; }
  if (!colocLineSeg) { alert('请先在图上拖动画一条线'); return; }
  const chA = $('colocChA').value, chB = $('colocChB').value;
  const lw = Math.max(1, +$('colocLineW').value || 1);
  const samples = sampleLine(state.imgData, chA, chB, colocLineSeg, lw);
  if (samples.length < 2) { alert('线太短，无法采样'); return; }
  const r = pearsonOf(samples);
  lastLine = { samples, chA, chB, line: colocLineSeg, lw, pearson: r };
  lastColoc = null;
  const L = colocLineSeg;
  const sign = r < -0.1 ? '（负相关，倾向互斥）' : '';
  $('colocResult').innerHTML =
    `<b>划线</b> (${Math.round(L.x0)},${Math.round(L.y0)}) → (${Math.round(L.x1)},${Math.round(L.y1)})，` +
    `线宽 ${lw}，采样点 ${samples.length}<br>` +
    `沿线 Pearson 系数 r = <b>${r.toFixed(3)}</b> — ${pearsonWord(r)}${sign}`;
  $('colocResult').classList.add('active');
  $('chartTitle').textContent = '双通道强度剖面';
  $('chartHint').textContent = '两条曲线峰谷重合 = 该处共定位强';
  drawProfile(samples, chA, chB);
});

$('colocClear').addEventListener('click', () => {
  colocLineSeg = null;
  drawColoc();
});

$('colocExport').addEventListener('click', () => {
  if (lastLine) {
    let csv = `划线共定位剖面\n通道A,${lastLine.chA},通道B,${lastLine.chB},线宽,${lastLine.lw},Pearson,${lastLine.pearson.toFixed(4)}\n`;
    csv += '沿线距离,通道A强度,通道B强度\n';
    lastLine.samples.forEach((s) => {
      csv += `${s.d},${s.a.toFixed(1)},${s.b.toFixed(1)}\n`;
    });
    downloadCsv(csv, '共定位_划线剖面.csv');
    return;
  }
  if (lastColoc) {
    let csv = '范围,通道A,通道B,像素数,Pearson_r,Manders_M1,Manders_M2\n';
    csv += `${lastColoc.scope},${lastColoc.chA},${lastColoc.chB},${lastColoc.n},${lastColoc.pearson.toFixed(4)},${lastColoc.m1.toFixed(4)},${lastColoc.m2.toFixed(4)}\n`;
    downloadCsv(csv, '共定位_整图.csv');
    return;
  }
  alert('暂无共定位结果，请先分析');
});
