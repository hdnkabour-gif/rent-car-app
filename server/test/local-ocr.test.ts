import { describe, expect, it } from 'vitest';
import { parseOcrProposal } from '../src/ocr/localOcr.js';

// #15 — what the local OCR worker may hand to the app (synthetic output only, ICAO specimen values).
const base = {
  engine: 'tesseract-local', kind: 'id_back', requiresHumanReview: true, enhanced: false, visualHash: '0123456789abcdef',
  quality: { blurVariance: 1113.6, brightness: 231.1, deskewDegrees: 0, averageWordConfidence: 84.2 }, warnings: [],
  fields: {
    documentNumber: { value: 'D23145890', confidence: 0.95, basis: 'mrz_td1_checksum' },
    birthDate: { value: '1974-08-12', raw: '740812', confidence: 0.9, basis: 'mrz_td1_checksum' },
  },
};

describe('local OCR output (#15)', () => {
  it('keeps the framing info and ISO dates, drops unknown properties, and stays a suggestion', () => {
    const p = parseOcrProposal(JSON.stringify({
      ...base,
      frame: { detected: true, corrected: true, assumedCropped: false, areaRatio: 0.369, corners: [[0.15, 0.23], [0.84, 0.26], [0.82, 0.81], [0.14, 0.75]] },
      fields: { ...base.fields, issueDate: { value: '03/02/2020', iso: '2020-02-03', confidence: 0.4, basis: 'labelled_unverified' } },
      somethingElse: 'dropped',
    }), 'id_back');
    expect(p.requiresHumanReview).toBe(true);
    expect(p.frame).toMatchObject({ detected: true, corrected: true, areaRatio: 0.369 });
    expect(p.fields.issueDate).toEqual({ value: '03/02/2020', iso: '2020-02-03', confidence: 0.4, basis: 'labelled_unverified' });
    expect(p.fields.birthDate).not.toHaveProperty('raw');
    expect(p).not.toHaveProperty('somethingElse');
  });

  it('rejects out-of-bounds or foreign output instead of trusting it', () => {
    const bad = [
      { ...base, frame: { detected: true, corrected: true, areaRatio: 3 } },                          // impossible ratio
      { ...base, frame: { detected: true, corrected: true, areaRatio: 0.3, corners: [[0, 0]] } },    // not 4 corners
      { ...base, fields: { x: { value: 'a', iso: '20-2-3', confidence: 0.4, basis: 'b' } } },        // not an ISO date
      { ...base, requiresHumanReview: false },                                                      // never auto-accepted
      { ...base, warnings: Array(11).fill('too_dark') },
    ];
    for (const b of bad) expect(() => parseOcrProposal(JSON.stringify(b), 'id_back')).toThrow(/invalid result/);
    expect(() => parseOcrProposal(JSON.stringify(base), 'passport')).toThrow(/invalid result/);          // other kind
    expect(() => parseOcrProposal('not json', 'id_back')).toThrow(/invalid result/);
  });
});
