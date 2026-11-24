import type { DefectClass } from "./classes.ts";
import type { MeasureOptions } from "./measure.ts";

export interface MeasureContext {
  readonly flag: (c: DefectClass, opId: string, detail?: Record<string, unknown>) => void;
  readonly notes: string[];
  readonly spec0: any;
  readonly rawDocs: any[];
  readonly options: MeasureOptions | undefined;
}

export interface ExtractedOps {
  readonly extracted: Map<string, any>;
  readonly specOps: number;
}
