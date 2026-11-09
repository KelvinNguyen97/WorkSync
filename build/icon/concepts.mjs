// Draws the WorkSync icon concepts as SVG (viewBox 0 0 100 100).
const rad = (d) => (d * Math.PI) / 180;
const pt = (cx, cy, r, d) => [
  cx + r * Math.cos(rad(d)),
  cy + r * Math.sin(rad(d)),
];
const f = (n) => +n.toFixed(2);

/** A clockwise arc from a to b degrees with an arrowhead at b. */
function arrowArc(cx, cy, r, a, b, w, head = 1) {
  const [x1, y1] = pt(cx, cy, r, a);
  const [x2, y2] = pt(cx, cy, r, b - 6 * head);
  const large = (b - a) % 360 > 180 ? 1 : 0;
  const arc = `<path d="M${f(x1)} ${f(y1)} A${r} ${r} 0 ${large} 1 ${f(x2)} ${f(y2)}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round"/>`;
  const [ex, ey] = pt(cx, cy, r, b);
  const dir = [-Math.sin(rad(b)), Math.cos(rad(b))];
  const per = [-dir[1], dir[0]];
  const L = w * 2.1 * head,
    W = w * 1.55 * head;
  const tip = [ex + dir[0] * L * 0.45, ey + dir[1] * L * 0.45];
  const base = [tip[0] - dir[0] * L, tip[1] - dir[1] * L];
  const w1 = [base[0] + per[0] * W, base[1] + per[1] * W];
  const w2 = [base[0] - per[0] * W, base[1] - per[1] * W];
  const head_ = `<path d="M${f(tip[0])} ${f(tip[1])} L${f(w1[0])} ${f(w1[1])} L${f(w2[0])} ${f(w2[1])} Z" fill="#fff" stroke="#fff" stroke-width="${w * 0.35}" stroke-linejoin="round"/>`;
  return arc + head_;
}

const tile = (id, from, to) => `
  <defs>
    <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
    <linearGradient id="h${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="92" height="92" rx="22" fill="url(#g${id})"/>
  <rect x="4" y="4" width="92" height="92" rx="22" fill="url(#h${id})"/>
  <rect x="4.5" y="4.5" width="91" height="91" rx="21.5" fill="none" stroke="#fff" stroke-opacity=".18"/>`;

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

export const concepts = {
  // A: a task tick inside two sync arrows: work kept in step.
  a: svg(
    tile('a', '#4fd3e3', '#0a6577') +
      arrowArc(50, 50, 29, 200, 335, 6.5) +
      arrowArc(50, 50, 29, 20, 155, 6.5) +
      `<path d="M37 51 L46.5 60.5 L64 42" fill="none" stroke="#fff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  // B: the customer's sheet and your copy, side by side and in step.
  b: svg(
    tile('b', '#6c8cff', '#2f3fb0') +
      `<rect x="20" y="24" width="38" height="50" rx="7" fill="#fff" fill-opacity=".38" transform="rotate(-9 39 49)"/>
       <rect x="40" y="27" width="40" height="52" rx="7" fill="#fff"/>
       <path d="M48 39 H72 M48 48 H66" stroke="#2f3fb0" stroke-opacity=".35" stroke-width="4.5" stroke-linecap="round"/>
       <path d="M49 62 L56 69 L71 54" fill="none" stroke="#2f3fb0" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  // C: a W in one stroke, ringed by a single sync arrow.
  c: svg(
    tile('c', '#ffb04a', '#e0532f') +
      arrowArc(50, 50, 32, 120, 410, 5.5) +
      `<path d="M31 40 L39.5 63 L50 45 L60.5 63 L69 40" fill="none" stroke="#fff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
};

/** The tray glyph: the main shape without the tile, for small sizes. */
export const trayGlyph = (color = '#fff') =>
  svg(
    arrowArc(50, 50, 38, 200, 335, 10).replaceAll('#fff', color) +
      arrowArc(50, 50, 38, 20, 155, 10).replaceAll('#fff', color) +
      `<path d="M33 51 L46 64 L68 40" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
