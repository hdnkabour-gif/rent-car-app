/** Cheap on-device sharpness guidance for a document camera frame.
 * Uses Laplacian variance on a downscaled luminance raster. This is advisory,
 * not OCR or proof that a document is legible; thresholds are deliberately conservative.
 */
export function laplacianVariance(luma: Uint8ClampedArray | number[], width: number, height: number): number {
  if (width < 3 || height < 3 || luma.length !== width * height) return 0;
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const k = y * width + x;
      const delta = 4 * luma[k]! - luma[k - width]! - luma[k + width]!
        - luma[k - 1]! - luma[k + 1]!;
      sum += delta;
      squares += delta * delta;
      count += 1;
    }
  }
  const mean = sum / count;
  return squares / count - mean * mean;
}

export function frameSharpness(canvas: HTMLCanvasElement): number | null {
  const sample = document.createElement('canvas');
  sample.width = 160;
  sample.height = 120;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, 160, 120);
  const pixels = ctx.getImageData(0, 0, 160, 120).data;
  const gray = new Uint8ClampedArray(160 * 120);
  for (let i = 0; i < gray.length; i += 1) {
    const p = i * 4;
    gray[i] = Math.round(0.299 * pixels[p]! + 0.587 * pixels[p + 1]! + 0.114 * pixels[p + 2]!);
  }
  return laplacianVariance(gray, 160, 120);
}

/** Very low signal is likely blurred or a uniformly dark/blank frame. */
export function shouldRetakeDocumentFrame(score: number | null): boolean {
  return score !== null && score < 35;
}
