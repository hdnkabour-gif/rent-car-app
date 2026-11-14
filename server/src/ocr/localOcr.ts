import { execFile } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import type { FileStorage } from '../storage/storage.js';

const exec = promisify(execFile);
const Kind = z.enum(['id_front','id_back','passport','licence_front','licence_back','residence_permit','other',
  'registration','insurance','technical_inspection','vignette','transport_authorization',
  'other_vehicle','contract_signed']);
const Suggestion = z.object({
  value: z.string().min(1).max(160), confidence: z.number().min(0).max(1), basis: z.string().max(40),
});
const Response = z.object({
  engine: z.literal('tesseract-local'),
  kind: Kind,
  requiresHumanReview: z.literal(true),
  enhanced: z.boolean().optional(),
  fields: z.record(z.string(),Suggestion),
  visualHash: z.string().regex(/^[0-9a-f]{16}$/),
  quality: z.object({
    blurVariance: z.number().min(0),
    brightness: z.number().min(0).max(255),
    deskewDegrees: z.number(),
    averageWordConfidence: z.number().min(0).max(100),
  }),
  warnings: z.array(z.string().max(40)).max(10),
});
export type OcrProposal = z.infer<typeof Response>;

function workerPath(): string | null {
  // The source file is included with the repository. It is never downloaded or fetched remotely.
  const candidates = [
    path.resolve(process.cwd(),'server/tools/document_ocr.py'),
    path.resolve(process.cwd(),'tools/document_ocr.py'),
  ];
  return candidates.find(existsSync) ?? null;
}

export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) {
    throw new Error('Invalid visual fingerprint');
  }
  let x = BigInt('0x'+a) ^ BigInt('0x'+b);
  let n = 0;
  while (x) { x &= x - 1n; n += 1; }
  return n;
}

/** Tesseract is off unless explicitly enabled on a trusted private service.
 * Never persist the OCR text, output stdout to logs or auto-approve any suggestion.
 */
export async function analyzePrivateDocument(
  storage: FileStorage,
  item: { storage_key: string; size_bytes: number; mime_type: string },
  kind: z.infer<typeof Kind>,
): Promise<OcrProposal> {
  if (process.env.FLEETORA_OCR_ENABLED !== 'true') {
    throw new AppError(503,'ocr_disabled','Local OCR is not enabled on this server');
  }
  const script = workerPath();
  if (!script) throw new AppError(503,'ocr_unavailable','Local OCR worker is not installed');
  if (item.size_bytes <= 0 || item.size_bytes > 20_000_000) {
    throw new AppError(413,'ocr_file_too_large','The document is too large to process');
  }
  const ext: Record<string,string> = {
    'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','application/pdf':'.pdf',
  };
  const suffix = ext[item.mime_type];
  if (!suffix) throw new AppError(415,'ocr_unsupported','OCR does not support this file type');
  const directory = await mkdtemp(path.join(tmpdir(),'fleetora-private-ocr-'));
  try {
    const name = path.join(directory,'document'+suffix);
    await pipeline(storage.read(item.storage_key),createWriteStream(name,{flags:'wx',mode:0o600}));
    let stdout: string;
    try {
      ({stdout} = await exec(process.env.FLEETORA_OCR_PYTHON || 'python3',
        [script,name,kind],{
          timeout:55_000,maxBuffer:80_000,windowsHide:true,
          env:{ ...process.env, PYTHONIOENCODING:'utf-8' },
        }));
    } catch {
      throw new AppError(503,'ocr_unavailable','Local OCR could not process this document');
    }
    try {
      const proposal = Response.parse(JSON.parse(stdout));
      if (proposal.kind !== kind) throw new Error('Wrong document kind');
      return proposal;
    } catch {
      throw new AppError(503,'ocr_unavailable','Local OCR returned an invalid result');
    }
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
}
