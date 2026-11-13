import { describe, expect, it, vi } from 'vitest';
import { hammingDistance, analyzePrivateDocument } from '../src/ocr/localOcr.js';
import type { FileStorage } from '../src/storage/storage.js';

describe('private OCR review boundary', () => {
  it('compares advisory 64-bit visual fingerprints without interpreting them as identity', () => {
    expect(hammingDistance('0000000000000000','0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000','ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000000','0000000000000001')).toBe(1);
    expect(() => hammingDistance('malformed','ffffffffffffffff')).toThrow(/fingerprint/);
  });

  it('rejects OCR attempts while the trusted local worker is disabled, without reading files', async () => {
    const previous=process.env.FLEETORA_OCR_ENABLED;
    delete process.env.FLEETORA_OCR_ENABLED;
    const storage: FileStorage = {
      put:vi.fn(),read:vi.fn(),exists:vi.fn(),
    };
    try {
      await expect(analyzePrivateDocument(storage,{
        storage_key:'aa/'+ 'a'.repeat(64),
        size_bytes:123,mime_type:'image/png',
      },'id_front')).rejects.toMatchObject({ status:503, code:'ocr_disabled' });
      expect(storage.read).not.toHaveBeenCalled();
    } finally {
      if(previous===undefined)delete process.env.FLEETORA_OCR_ENABLED;
      else process.env.FLEETORA_OCR_ENABLED=previous;
    }
  });
});
