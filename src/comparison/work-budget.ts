/** Bound CPU work between yields without sleeping for every empty atlas block. */
export function workBudget(yieldWork?: () => Promise<void>) {
  let deadline = performance.now() + 4;
  return () => {
    if (!yieldWork || performance.now() < deadline) return;
    return yieldWork().then(() => { deadline = performance.now() + 4; });
  };
}
