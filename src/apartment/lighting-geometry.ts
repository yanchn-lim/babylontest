/** Same world-space area tolerance used for architectural lighting charts. */
export function hasLightingArea(a: readonly number[], b: readonly number[], c: readonly number[]) {
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
  const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) > 1e-10;
}

/** Keep source vertex addresses while excluding zero-area lighting faces. */
export function lightingIndices(positions: number[], indices: number[]) {
  const result: number[] = [];
  for (let face = 0; face < indices.length; face += 3) {
    const [a, b, c] = indices.slice(face, face + 3);
    if (hasLightingArea(positions.slice(a * 3, a * 3 + 3), positions.slice(b * 3, b * 3 + 3), positions.slice(c * 3, c * 3 + 3))) result.push(a, b, c);
  }
  return result;
}
