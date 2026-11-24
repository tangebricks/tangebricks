// Preloaded with `node --import` by the H7 test for its second run: moves the clock forward by a little over a year.
// An assembler that stamps the time, even only the date, then produces different files in the two runs; with the real
// clock in both, a date-only stamp would be identical across two runs made seconds apart and go unnoticed.
const OFFSET_MS = 400 * 24 * 60 * 60 * 1000 + 12_345;
const RealDate = Date;

class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    // With no argument `new Date()` means "now", which is the thing being shifted; with arguments it is a plain date.
    if (args.length === 0) super(RealDate.now() + OFFSET_MS);
    else super(...(args as [number]));
  }
  static override now(): number {
    return RealDate.now() + OFFSET_MS;
  }
}
globalThis.Date = ShiftedDate as unknown as DateConstructor;
