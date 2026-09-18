import { createLiveViewer } from '../apartment/live-viewer';
import { loadFixture, type Placement } from './fixture';
import type { Layout } from './furnishings';

export async function createPreview(canvas: HTMLCanvasElement, base: string, status: HTMLElement, onReady: (revision: number) => void) {
  let fixture: Awaited<ReturnType<typeof loadFixture>>;
  const viewer = await createLiveViewer(canvas, async scene => {
    fixture = await loadFixture(scene, base, false);
    fixture.select('single', 'original');
    return fixture;
  }, { onReady, onStatus: text => { status.textContent = text; } });
  return { ...viewer,
    place(layout: Layout, placement: Placement, revision: number) {
      const selected = fixture.select(layout, placement); viewer.reset(revision, selected.meshes);
      return selected.counts;
    },
  };
}
