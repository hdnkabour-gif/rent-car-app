import { describe, expect, it } from 'vitest';
import { laplacianVariance, shouldRetakeDocumentFrame } from '../src/imageQuality';

describe('document camera sharpness guidance', () => {
  it('scores a uniform synthetic image as unsharp', () => {
    const blank = Array(16 * 16).fill(128);
    expect(laplacianVariance(blank,16,16)).toBe(0);
    expect(shouldRetakeDocumentFrame(0)).toBe(true);
  });
  it('detects high-frequency detail in a synthetic checkerboard image', () => {
    const pixels = Array.from({length:16*16},(_,i)=>((Math.floor(i/16)+i%16)%2 ? 255 : 0));
    expect(laplacianVariance(pixels,16,16)).toBeGreaterThan(200);
    expect(shouldRetakeDocumentFrame(laplacianVariance(pixels,16,16))).toBe(false);
  });
  it('does not block capture when canvas quality information is unavailable', () => {
    expect(shouldRetakeDocumentFrame(null)).toBe(false);
    expect(laplacianVariance([],0,0)).toBe(0);
  });
});
