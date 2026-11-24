// The few parts of jsdom this folder uses; the package ships no type declarations of its own.
declare module "jsdom" {
  export interface JSDOMOptions {
    url?: string;
    runScripts?: "dangerously" | "outside-only";
    pretendToBeVisual?: boolean;
    beforeParse?(window: Window & typeof globalThis): void;
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
