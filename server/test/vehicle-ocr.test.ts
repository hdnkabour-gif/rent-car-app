import { describe, expect, it, vi } from 'vitest';
import { analyzeVehiclePhoto } from '../src/ocr/vehicleOcr.js';
import type { FileStorage } from '../src/storage/storage.js';

describe('vehicle OCR security and review safety', () => {
  const image={storage_key:'aa/'+'a'.repeat(64),size_bytes:1500,mime_type:'image/png'};
  it('is disabled unless a trusted service explicitly enables it',async()=>{
    const old=process.env.FLEETORA_OCR_ENABLED;
    delete process.env.FLEETORA_OCR_ENABLED;
    const store={read:vi.fn()} as unknown as FileStorage;
    try{
      await expect(analyzeVehiclePhoto(store,image,'vehicle_plate')).rejects.toMatchObject({status:503,code:'ocr_disabled'});
      expect(store.read).not.toHaveBeenCalled();
    } finally {
      if(old===undefined) delete process.env.FLEETORA_OCR_ENABLED;
      else process.env.FLEETORA_OCR_ENABLED=old;
    }
  });
  it('rejects non-images and very large data before it reads the stored file',async()=>{
    const old=process.env.FLEETORA_OCR_ENABLED;
    process.env.FLEETORA_OCR_ENABLED='true';
    const store={read:vi.fn()} as unknown as FileStorage;
    try{
      await expect(analyzeVehiclePhoto(store,{...image,mime_type:'application/pdf'},'vehicle_plate'))
        .rejects.toMatchObject({status:415,code:'unsupported_photo'});
      await expect(analyzeVehiclePhoto(store,{...image,size_bytes:25_000_000},'vehicle_odometer'))
        .rejects.toMatchObject({status:413,code:'file_too_large'});
      expect(store.read).not.toHaveBeenCalled();
    } finally {
      if(old===undefined) delete process.env.FLEETORA_OCR_ENABLED;
      else process.env.FLEETORA_OCR_ENABLED=old;
    }
  });
});
