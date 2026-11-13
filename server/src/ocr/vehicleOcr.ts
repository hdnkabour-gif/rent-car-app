import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { FileStorage } from '../storage/storage.js';
import { AppError } from '../http/errors.js';

const run = promisify(execFile);
export const VehicleImageKind = z.enum(['vehicle_plate', 'vehicle_odometer']);
const Candidate = z.object({
  value: z.number().int().min(0).max(2_000_000),
  confidence: z.number().min(0).max(1),
  basis: z.string().max(80),
});
const PlateValue = z.object({value:z.string().max(100),confidence:z.number().min(0).max(1),basis:z.string().max(80)});
const Result = z.discriminatedUnion('kind',[
  z.object({engine:z.literal('tesseract-local'),kind:z.literal('vehicle_plate'),
    requiresHumanReview:z.literal(true),fields:z.record(z.string(),PlateValue)}),
  z.object({engine:z.literal('tesseract-local'),kind:z.literal('vehicle_odometer'),
    requiresHumanReview:z.literal(true),candidates:z.array(Candidate).max(8),warning:z.string().max(180)}),
]);
export type VehicleImageOcrResult = z.infer<typeof Result>;

/** Private, opt-in processing of already uploaded photos. No automatic mileage/plate change. */
export async function analyzeVehiclePhoto(
  storage: FileStorage,
  photo: {storage_key:string;mime_type:string;size_bytes:number},
  kind: z.infer<typeof VehicleImageKind>,
): Promise<VehicleImageOcrResult> {
  if(process.env.FLEETORA_OCR_ENABLED !== 'true') {
    throw new AppError(503,'ocr_disabled','Local OCR is disabled');
  }
  const script = [
    path.resolve(process.cwd(),'server/tools/vehicle_ocr.py'),
    path.resolve(process.cwd(),'tools/vehicle_ocr.py'),
  ].find(existsSync);
  if(!script) throw new AppError(503,'ocr_unavailable','Vehicle OCR worker is missing');
  const extensions:Record<string,string> = {'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'};
  const suffix = extensions[photo.mime_type];
  if(!suffix) throw new AppError(415,'unsupported_photo','Vehicle OCR accepts images only');
  if(photo.size_bytes<=0 || photo.size_bytes>20_000_000) {
    throw new AppError(413,'file_too_large','Photo too large');
  }
  const folder=await mkdtemp(path.join(tmpdir(),'fleetora-vehicle-ocr-'));
  try {
    const target=path.join(folder,'image'+suffix);
    await pipeline(storage.read(photo.storage_key),createWriteStream(target,{flags:'wx',mode:0o600}));
    let stdout='';
    try {
      ({stdout}=await run(process.env.FLEETORA_OCR_PYTHON || 'python3',[script,target,kind],{
        timeout:35_000,maxBuffer:40_000,windowsHide:true,
        env:{...process.env,PYTHONIOENCODING:'utf-8'},
      }));
      return Result.parse(JSON.parse(stdout));
    } catch {
      throw new AppError(503,'ocr_unavailable','Vehicle photo OCR failed');
    }
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
}
