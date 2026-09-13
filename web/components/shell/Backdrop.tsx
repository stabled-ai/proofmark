'use client';

import { usePathname } from 'next/navigation';

/*
 * Node constellation on a 1600×760 stage, centred under the header. Hand-placed so the edges
 * read as a network, not noise, and so they run through the header band, the corridor between
 * the hero copy and its panel, and the gutters — never through the headline. Three nodes glow.
 * The stage fades out before the ticker; product pages clip it to the header band.
 */
const NODES: [number, number, boolean?][] = [
  [180, 40], [420, 120], [700, 30], [960, 110], [1240, 60, true], [1500, 140],
  [760, 230, true], [880, 330], [720, 440], [900, 520],
  [1460, 300], [1560, 460],
  [60, 290], [120, 480, true],
  [300, 640], [1100, 620],
];
const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5],
  [2, 6], [3, 7], [6, 7], [7, 8], [8, 9], [9, 15],
  [5, 10], [4, 10], [10, 11], [11, 15],
  [0, 12], [12, 13], [13, 14], [9, 14],
];

export function Backdrop() {
  const path = usePathname();
  return (
    <div className="backdrop" data-depth={path === '/' ? 'deep' : 'shallow'} aria-hidden>
      <div className="backdrop-grid" />
      <svg className="backdrop-net" viewBox="0 0 1600 760" fill="none">
        <g stroke="currentColor" strokeOpacity="0.12" strokeWidth="1">
          {EDGES.map(([a, b]) => <line key={`${a}-${b}`} x1={NODES[a][0]} y1={NODES[a][1]} x2={NODES[b][0]} y2={NODES[b][1]} />)}
        </g>
        {NODES.map(([x, y, bright], i) => bright
          ? <g key={i}><circle cx={x} cy={y} r="9" fill="currentColor" fillOpacity="0.14" /><circle cx={x} cy={y} r="3.5" fill="currentColor" /></g>
          : <circle key={i} cx={x} cy={y} r="3" fill="currentColor" fillOpacity="0.45" />)}
      </svg>
    </div>
  );
}
