// nda-image.mjs — is this actually an image we can safely embed?
//
// ⚠ THE REASON THIS EXISTS. pdf-lib's PNG decoder does not merely throw on a
// malformed file: on some it spins FOREVER, synchronously. A try/catch cannot
// catch that, and neither can a Promise timeout — a synchronous loop blocks the
// event loop, so nothing else gets to run. Found live: a corrupt signature PNG
// hung the sign endpoint past the platform timeout, and because the signature
// is recorded BEFORE the PDF is rendered, the agreement came out signed with no
// PDF, nothing filed in the vault and no email to either party. Silent, and
// exactly the failure the "filing is best-effort" design is supposed to make
// visible.
//
// So: check the container before handing it to the decoder. Structural only —
// we are not decoding pixels, just refusing to pass on something that is not a
// well-formed file. A real signature from a canvas or a phone photo passes; a
// truncated upload or a renamed .docx does not.

/** Walk PNG chunks. Every length must fit, IHDR first, IEND present. */
function validPng(b) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 57) return false;                       // signature + IHDR + IEND
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return false;

  let i = 8, first = true, sawEnd = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    // A length that runs past the buffer is the whole bug: pdf-lib trusts it.
    if (len > b.length - i - 12) return false;
    const type = b.toString('latin1', i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (first && type !== 'IHDR') return false;
    if (type === 'IEND') { sawEnd = true; break; }
    first = false;
    i += 12 + len;
  }
  if (!sawEnd) return false;

  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const depth = b[24], colour = b[25];
  if (!w || !h || w > 20000 || h > 20000) return false;
  if (![1, 2, 4, 8, 16].includes(depth)) return false;
  if (![0, 2, 3, 4, 6].includes(colour)) return false;
  return true;
}

/** JPEG: the markers at both ends, and a sane length. */
function validJpeg(b) {
  return b.length > 125 && b[0] === 0xff && b[1] === 0xd8
    && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}

/**
 * Parse a data URL into embeddable bytes, or null.
 *
 * Null means "render the document without this image" — never an exception,
 * because losing an executed agreement over a picture would be absurd. Callers
 * that can still ask a human to try again (the signing page, the signature
 * editor) should use `describeImageProblem` and say so instead.
 */
export function safeImageBytes(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  let bytes;
  try { bytes = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (!bytes.length || bytes.length > 6_000_000) return null;
  const png = m[1].toLowerCase() === 'png';
  if (png ? !validPng(bytes) : !validJpeg(bytes)) return null;
  return { bytes, png };
}

/** A sentence for a human who just tried to give us this, or null if it's fine. */
export function describeImageProblem(dataUrl) {
  if (!dataUrl) return null;                       // absent is allowed everywhere
  return safeImageBytes(dataUrl)
    ? null
    : 'That signature image could not be read. Draw it again, or upload a PNG or JPEG under about 5 MB.';
}
