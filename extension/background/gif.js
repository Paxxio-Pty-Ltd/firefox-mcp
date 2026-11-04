// A small animated-GIF encoder for the run recorder, so no library has to be bundled.
// Every frame uses one fixed palette: a 6x6x6 colour cube plus a 40-step grey ramp,
// since UI screenshots are mostly greys and a cube alone tints them. No per-frame
// colour quantising is needed.

const GIF_GREYS = 40;
const GIF_PALETTE = (() => {
  const palette = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) palette.set([r * 51, g * 51, b * 51], (i++) * 3);
    }
  }
  for (let grey = 0; grey < GIF_GREYS; grey++) {
    const level = Math.round((grey * 255) / (GIF_GREYS - 1));
    palette.set([level, level, level], (i++) * 3);
  }
  return palette;
})();

// RGBA pixels -> palette indices. Near-grey pixels use the grey ramp.
function gifIndices(rgba) {
  const indices = new Uint8Array(rgba.length / 4);
  for (let p = 0, i = 0; i < indices.length; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 16) {
      indices[i] = 216 + Math.round((((r + g + b) / 3) * (GIF_GREYS - 1)) / 255);
    } else {
      indices[i] = Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
    }
  }
  return indices;
}

// Variable-width LZW as the GIF format wants it, with 8-bit symbols.
function gifLzw(indices) {
  const minCodeSize = 8;
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = [];
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let dict = new Map();
  let buffer = 0;
  let bits = 0;
  const emit = (code) => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>>= 8;
      bits -= 8;
    }
  };

  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const symbol = indices[i];
    const key = prefix * 256 + symbol;
    const known = dict.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = end + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      dict.set(key, next++);
    }
    prefix = symbol;
  }
  emit(prefix);
  emit(end);
  if (bits > 0) out.push(buffer & 0xff);
  return out;
}

// frames: [{ rgba: Uint8ClampedArray, delay: hundredths of a second }], all width x height.
function encodeGif(frames, width, height) {
  const bytes = [];
  const word = (n) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  const text = (s) => bytes.push(...[...s].map((c) => c.charCodeAt(0)));

  text("GIF89a");
  word(width);
  word(height);
  bytes.push(0xf7, 0, 0); // global colour table of 256 entries
  for (const value of GIF_PALETTE) bytes.push(value);
  // Loop forever.
  bytes.push(0x21, 0xff, 0x0b);
  text("NETSCAPE2.0");
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of frames) {
    bytes.push(0x21, 0xf9, 0x04, 0x04);
    word(frame.delay);
    bytes.push(0x00, 0x00);
    bytes.push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    bytes.push(0x00, 8);
    const data = gifLzw(gifIndices(frame.rgba));
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0x00);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}
