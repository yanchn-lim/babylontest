import type { TransferCheckpoint } from '../comparison/transfer-checkpoint';
import type { SceneData } from '../comparison/main';
import type { PreparationTimings } from '../comparison/preparation-schedule';
import type { Placement } from './fixture';
import type { Layout } from './furnishings';
import type { LightingPreviewChunk, LightingPreviewState } from '../comparison/streaming-preview';

export interface RunSettings { layout: Layout; placement: Placement; batchSize: number; pauseMilliseconds: number; trial: boolean; strategy: 'active' | 'reference'; interactive: boolean; streaming: boolean; progressive: boolean }
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
export type WorkerRequest = { type: 'cancel'; id: number } | { type: 'budget'; id: number; frameMilliseconds: number }
  | { type: 'checkpoint-ack'; id: number; rays: number }
  | { type: 'stream-ack'; id: number; sequence: number }
  | { type: 'run'; id: number; base: string; settings: RunSettings };
export type WorkerReply = { type: 'progress'; id: number; stage: string; fraction: number; timings?: PreparationTimings }
  | { type: 'stream-start'; id: number; atlas: number[][]; sceneData: SceneData; lighting: LightingPreviewState; checkpoints: boolean }
  | ({ type: 'checkpoint'; id: number } & TransferCheckpoint)
  | ({ type: 'stream-chunk'; id: number } & LightingPreviewChunk)
  | { type: 'result'; id: number; report: RunReport; atlas?: number[][]; sceneData?: SceneData; transferBytes?: ArrayBuffer }
  | { type: 'error'; id: number; message: string };

export function compareResult(report: RunReport, references: Map<string, string>) {
  if (report.outcome !== 'complete' || !report.inputHash || !report.outputHash) return 'Not compared';
  const reference = references.get(report.inputHash);
  if (!reference) { references.set(report.inputHash, report.outputHash); return 'Reference'; }
  return reference === report.outputHash ? 'Exact match' : 'MISMATCH';
}
