// Runs Segment Anything (SlimSAM) in the browser so a click turns into a furniture outline.
// Model weights download from Hugging Face on first use (~25 MB) and are cached by the browser.
import { SamModel, AutoProcessor, RawImage, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

env.allowLocalModels = false;

const MODEL_ID = 'Xenova/slimsam-77-uniform';
let model = null;
let processor = null;
let device = 'wasm';
let current = { imageId: null, inputs: null, embeddings: null };

// Handle messages strictly one after another so a decode never races an embed.
let chain = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  chain = chain
    .then(() => handle(msg))
    .catch((err) => self.postMessage({
      type: 'error',
      message: String(err?.message || err),
      selId: msg.selId ?? null,
      during: msg.type,
    }));
};

function status(text) { self.postMessage({ type: 'status', text }); }

async function load() {
  if (model) return;
  let hasGPU = false;
  try { hasGPU = !!(self.navigator?.gpu && await self.navigator.gpu.requestAdapter()); } catch { hasGPU = false; }
  device = hasGPU ? 'webgpu' : 'wasm';

  const files = {};
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      status(`Loading object detector… ${Math.round((l / t) * 100)}%`);
    }
  };

  status('Loading object detector…');
  try {
    model = await SamModel.from_pretrained(MODEL_ID, { device, dtype: device === 'webgpu' ? 'fp16' : 'fp32', progress_callback });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    device = 'wasm';
    model = await SamModel.from_pretrained(MODEL_ID, { device, dtype: 'fp32', progress_callback });
  }
  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  self.postMessage({ type: 'ready', device });
}

async function embed(imageId, url) {
  if (current.imageId === imageId) return;
  status('Analysing photo…');
  const image = await RawImage.read(url);
  const inputs = await processor(image);
  const embeddings = await model.get_image_embeddings(inputs);
  current = { imageId, inputs, embeddings };
  self.postMessage({ type: 'embedded', imageId });
}

async function decode({ selId, imageId, points }) {
  if (current.imageId !== imageId) throw new Error('Photo changed before the selection was ready');
  const { inputs, embeddings } = current;
  const [rh, rw] = inputs.reshaped_input_sizes[0];

  const coords = points.flatMap((p) => [p.x * rw, p.y * rh]);
  const input_points = new Tensor('float32', coords, [1, 1, points.length, 2]);
  const input_labels = new Tensor('int64', points.map((p) => BigInt(p.label)), [1, 1, points.length]);

  const out = await model({ ...embeddings, input_points, input_labels });
  const masks = await processor.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);

  const t = masks[0];                      // [1, n, H, W]
  const [, n, H, W] = t.dims;
  const data = t.data;
  const scores = out.iou_scores.data;
  const size = H * W;

  // SAM gives 3 guesses (part / object / bigger). Among the confident ones, take the largest:
  // for furniture you almost always want the whole piece, not just a cushion.
  let bestScore = -Infinity;
  for (let i = 0; i < n; i++) bestScore = Math.max(bestScore, scores[i]);
  let pick = 0, pickArea = -1;
  for (let i = 0; i < n; i++) {
    if (scores[i] < bestScore - 0.04) continue;
    let area = 0;
    const off = i * size;
    for (let j = 0; j < size; j++) if (data[off + j]) area++;
    if (area > pickArea) { pickArea = area; pick = i; }
  }

  const mask = new Uint8Array(size);
  const off = pick * size;
  for (let j = 0; j < size; j++) mask[j] = data[off + j] ? 1 : 0;

  self.postMessage({ type: 'mask', selId, imageId, mask, w: W, h: H }, [mask.buffer]);
}

async function handle(msg) {
  if (msg.type === 'load') return load();
  await load();
  if (msg.type === 'embed') return embed(msg.imageId, msg.url);
  if (msg.type === 'decode') return decode(msg);
}
