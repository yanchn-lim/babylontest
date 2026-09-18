import type { SceneData } from '../comparison/main';
import type { PreparationTimings } from '../comparison/preparation-schedule';
import type { Placement } from './fixture';
import type { Layout } from './furnishings';

export interface RunSettings { layout: Layout; placement: Placement; batchSize: number; pauseMilliseconds: number; trial: boolean; strategy: 'active' | 'reference' }
export interface RunReport extends RunSettings {
  outcome: 'complete' | 'trial' | 'cancelled' | 'failed';
  error?: string;
  counts?: { objects: number; meshes: number; triangles: number };
  ignoredTriangles?: number;
  atlasHeight?: number;
  atlasBuilds?: number;
  atlasCacheHits?: number;
  packingAttempts?: number;
  totalMilliseconds: number;
  stages: Record<string, number>;
  timings?: PreparationTimings;
  inputHash?: string;
  outputHash?: string;
  bytes?: number;
  warm: boolean;
}
export type WorkerRequest = { type: 'cancel' } | { type: 'run'; id: number; base: string; settings: RunSettings };
export type WorkerReply = { type: 'progress'; id: number; stage: string; fraction: number; timings?: PreparationTimings }
  | { type: 'result'; id: number; report: RunReport; atlas?: number[][]; sceneData?: SceneData; gzip?: Uint8Array }
  | { type: 'error'; id: number; message: string };

export function compareResult(report: RunReport, references: Map<string, string>) {
  if (report.outcome !== 'complete' || !report.inputHash || !report.outputHash) return 'Not compared';
  const reference = references.get(report.inputHash);
  if (!reference) { references.set(report.inputHash, report.outputHash); return 'Reference'; }
  return reference === report.outputHash ? 'Exact match' : 'MISMATCH';
}
