import {
  byDate,
  fileInfo,
  moduleName,
  previousVersion,
  productsOf,
  sheetDate,
  type Release,
  type ReleaseLists,
} from '../shared/releases';
import type { ReleaseSheetLanguage } from './releaseExcel';

/**
 * The releases as one HTML file: the timeline of the Releases view, with a
 * product filter and each file opening to what changed. Everything is in the
 * file (no fonts, scripts or pictures from elsewhere), so it opens offline in
 * any browser; it only shows, nothing can be changed in it.
 */

export type HtmlTheme = 'light' | 'dark' | 'auto';

const WORDS = {
  ja: {
    title: 'リリース',
    customer: '顧客',
    exported: '出力日',
    all: 'すべて',
    expand: 'すべて開く',
    collapse: 'すべて閉じる',
    planned: '予定',
    files: (n: number) => `${n} ファイル`,
    destination: '仕向け先',
    category: 'カテゴリ',
    version: 'バージョン',
    changes: '内容',
    purpose: '目的',
    verification: '検証',
    none: '情報なし',
    fromRelease: 'リリースの記載',
    noReleases: 'リリースはまだありません。',
    first: '初回',
  },
  en: {
    title: 'Releases',
    customer: 'Customer',
    exported: 'Exported',
    all: 'All',
    expand: 'Expand all',
    collapse: 'Collapse all',
    planned: 'Planned',
    files: (n: number) => (n === 1 ? '1 file' : `${n} files`),
    destination: 'Destination',
    category: 'Category',
    version: 'Version',
    changes: 'Change log',
    purpose: 'Purpose',
    verification: 'Verification',
    none: 'No info',
    fromRelease: 'From the release',
    noReleases: 'No releases yet.',
    first: 'first',
  },
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

export function releaseHtml(o: {
  project: string;
  customer: string;
  today: string;
  releases: Release[];
  lists: ReleaseLists;
  language: ReleaseSheetLanguage;
  theme: HtmlTheme;
  includePlanned: boolean;
}): string {
  const w = WORDS[o.language];
  const list = byDate(
    o.releases.filter((r) => o.includePlanned || r.status === 'released'),
  ).reverse();
  const data = {
    words: { ...w, files: undefined },
    fileWord: [w.files(1), w.files(2).replace('2', '{n}')],
    products: productsOf(list, o.lists),
    fields: o.lists.fields,
    releases: list.map((r) => ({
      product: r.product,
      version: r.version,
      target: r.target,
      date: r.status === 'planned' ? '' : sheetDate(r.releasedOn),
      planned: r.status === 'planned',
      summary: r.summary,
      files: r.modules.map((m) => {
        const info = fileInfo(r, m);
        return {
          name: m.fileName || moduleName(m),
          module: m.fileName ? m.module : '',
          destination: m.destination,
          category: m.category,
          environment: m.environment,
          version: m.version,
          previous: previousVersion(o.releases, r, m),
          changes: info.changes,
          purpose: info.purpose,
          verification: info.verification,
          fromRelease: info.fromRelease,
          extra: m.extra,
        };
      }),
    })),
  };
  // Inside a script element: nothing in the data can end it.
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  const theme = o.theme === 'auto' ? '' : ` data-theme="${o.theme}"`;
  return `<!doctype html>
<html lang="${o.language}"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(o.project)} — ${esc(w.title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--sunk:#f1f3f6;--fg:#141821;--fg2:#3d4552;--muted:#5a6372;--line:#dde1e7;--acc:#0b7285;--acc-soft:#e3f4f7;--plan:#9a6700;--plan-soft:#fff4d6;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0a0d12;--card:#151a22;--sunk:#0b0f15;--fg:#e7ebf2;--fg2:#b3bbc8;--muted:#8c96a7;--line:rgba(214,226,255,.12);--acc:#45c4d8;--acc-soft:rgba(69,196,216,.14);--plan:#fbd98a;--plan-soft:rgba(242,181,43,.14);color-scheme:dark}}
:root[data-theme=dark]{--bg:#0a0d12;--card:#151a22;--sunk:#0b0f15;--fg:#e7ebf2;--fg2:#b3bbc8;--muted:#8c96a7;--line:rgba(214,226,255,.12);--acc:#45c4d8;--acc-soft:rgba(69,196,216,.14);--plan:#fbd98a;--plan-soft:rgba(242,181,43,.14);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI","Meiryo UI","Hiragino Sans",system-ui,sans-serif}
.mono{font-family:Consolas,"BIZ UDGothic",ui-monospace,monospace}
main{max-width:1100px;margin:0 auto;padding:28px 16px 60px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:18px}
h1{margin:0;font-size:24px}
.sub{margin:4px 0 0;color:var(--muted)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:22px}
button{font:inherit;color:inherit}
.chip{height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);cursor:pointer}
.chip[aria-pressed=true]{border-color:var(--acc);background:var(--acc-soft)}
.chip b{font-weight:500;opacity:.7;margin-left:6px;font-size:12px}
.sp{flex:1}
.btn{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);cursor:pointer}
ol{list-style:none;margin:0;padding:0}
.ms{display:grid;grid-template-columns:110px 24px minmax(0,1fr);column-gap:12px}
.when{text-align:right;padding-top:12px}
.when .d{font-size:15px;font-weight:700}
.when .p{color:var(--plan);font-weight:700}
.rail{position:relative;display:flex;justify-content:center}
.rail:before{content:"";position:absolute;top:0;bottom:0;width:2px;background:var(--line)}
.dot{position:relative;margin-top:15px;width:14px;height:14px;border-radius:50%;border:3px solid var(--acc);background:var(--bg)}
.planned .dot{border:2px dashed var(--plan)}
.card{margin-bottom:18px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.head{padding:12px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;border-bottom:1px solid var(--line)}
.head h2{margin:0;font-size:16px}
.tag{font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;background:var(--sunk);color:var(--fg2)}
.tag.p{background:var(--plan-soft);color:var(--plan)}
.muted{color:var(--muted)}
.sum{padding:10px 16px 0;color:var(--fg2)}
ul{list-style:none;margin:0;padding:6px}
.f{border-radius:8px}
.f.open{background:var(--sunk)}
.row{width:100%;min-height:42px;padding:8px 12px;border:0;border-radius:8px;background:none;cursor:pointer;text-align:left;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.row:hover{background:var(--sunk)}
.row .n{font-weight:600}
.env{font-size:12px;padding:1px 7px;border-radius:6px;border:1px solid var(--line);color:var(--fg2)}
.ver{color:var(--acc);min-width:100px;text-align:right}
.chev{transition:transform .15s}
.open .chev{transform:rotate(180deg)}
.det{display:none;padding:2px 14px 14px 36px}
.open .det{display:block}
.meta{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:13px;color:var(--muted);margin-bottom:10px}
.meta b{color:var(--fg);font-weight:500}
.boxes{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.box{padding:10px 12px;border-radius:8px;background:var(--card);border:1px solid var(--line)}
.box .k{font-size:12px;font-weight:600;color:var(--muted);display:flex;gap:8px}
.box .k i{font-weight:400;font-style:normal}
.box .v{white-space:pre-line}
.none{color:var(--muted);font-style:italic}
.empty{padding:14px;border-radius:8px;border:1px dashed var(--line)}
@media (max-width:640px){.ms{grid-template-columns:0 18px minmax(0,1fr);column-gap:8px}.when{display:none}.head .dm{display:inline}}
.dm{display:none}
@media print{
:root,:root[data-theme]{--bg:#fff;--card:#fff;--sunk:#f4f5f7;--fg:#000;--fg2:#222;--muted:#555;--line:#bbb;--acc:#0b5563;--acc-soft:#eef;--plan:#7a5200;--plan-soft:#fff4d6;color-scheme:light}
.bar,.chev{display:none}
.det{display:block!important}
.card,.f{break-inside:avoid}
main{padding:0}
}
</style>
</head>
<body>
<main>
<header><div><h1>${esc(o.project)} — ${esc(w.title)}</h1><p class="sub">${o.customer ? `${esc(w.customer)}: ${esc(o.customer)} · ` : ''}${esc(w.exported)} ${esc(o.today)}</p></div></header>
<div class="bar" id="bar" role="group"></div>
<ol id="list"></ol>
</main>
<script type="application/json" id="data">${json}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent),W=D.words;
var bar=document.getElementById('bar'),list=document.getElementById('list');
var product='';
function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}
function chev(){var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('width','16');s.setAttribute('height','16');s.setAttribute('class','chev');s.setAttribute('aria-hidden','true');var p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d','M6 9l6 6 6-6');p.setAttribute('fill','none');p.setAttribute('stroke','currentColor');p.setAttribute('stroke-width','2');s.appendChild(p);return s}
function count(n){return n===1?D.fileWord[0]:D.fileWord[1].replace('{n}',n)}
function chips(){
bar.textContent='';
if(D.products.length>1){[''].concat(D.products).forEach(function(p){var b=el('button','chip',p||W.all);var n=D.releases.filter(function(r){return !p||r.product===p}).length;b.appendChild(el('b',null,String(n)));b.setAttribute('aria-pressed',String(p===product));b.onclick=function(){product=p;chips();draw()};bar.appendChild(b)})}
bar.appendChild(el('span','sp'));
var a=el('button','btn',W.expand);a.onclick=function(){all(true)};bar.appendChild(a);
var c=el('button','btn',W.collapse);c.onclick=function(){all(false)};bar.appendChild(c);
}
function all(open){list.querySelectorAll('.f').forEach(function(f){f.classList.toggle('open',open);f.querySelector('.row').setAttribute('aria-expanded',String(open))})}
function box(k,v,from){var b=el('div','box');var h=el('div','k',k);if(v&&from)h.appendChild(el('i',null,'('+W.fromRelease+')'));b.appendChild(h);b.appendChild(el('div',v?'v':'v none',v||W.none));return b}
function draw(){
list.textContent='';
var rs=D.releases.filter(function(r){return !product||r.product===product});
if(!rs.length){list.appendChild(el('li','empty muted',W.noReleases));return}
rs.forEach(function(r){
var li=el('li','ms'+(r.planned?' planned':''));
var when=el('div','when');when.appendChild(el('div',r.planned?'d p':'d mono',r.planned?W.planned:r.date));li.appendChild(when);
var rail=el('div','rail');rail.appendChild(el('div','dot'));li.appendChild(rail);
var card=el('section','card');var head=el('div','head');
head.appendChild(el('span','tag',r.product));head.appendChild(el('h2',null,r.version));
if(r.target)head.appendChild(el('span','muted',r.target));
head.appendChild(el('span','dm mono muted',r.planned?W.planned:r.date));
if(r.planned)head.appendChild(el('span','tag p',W.planned));
head.appendChild(el('span','sp'));head.appendChild(el('span','muted',count(r.files.length)));
card.appendChild(head);
if(r.summary)card.appendChild(el('div','sum',r.summary));
var ul=el('ul');
r.files.forEach(function(f){
var it=el('li','f');var row=el('button','row');row.type='button';row.setAttribute('aria-expanded','false');
row.appendChild(el('span','n mono',f.name));if(f.module)row.appendChild(el('span','muted',f.module));
row.appendChild(el('span','sp'));if(f.environment)row.appendChild(el('span','env',f.environment));
row.appendChild(el('span','ver mono',f.version));row.appendChild(chev());
row.onclick=function(){var o=!it.classList.contains('open');it.classList.toggle('open',o);row.setAttribute('aria-expanded',String(o))};
it.appendChild(row);
var det=el('div','det');var meta=el('div','meta');
function m(k,v,mono){if(!v)return;var s=el('span',null,k+' ');var b=el('b',mono?'mono':null,v);s.appendChild(b);meta.appendChild(s)}
m(W.destination,f.destination);m(W.category,f.category);
m(W.version,(f.previous||W.first)+' \\u2192 '+f.version,true);
D.fields.forEach(function(x){m(x.name,f.extra[x.key])});
det.appendChild(meta);
if(!f.changes&&!f.purpose&&!f.verification)det.appendChild(el('div','empty none',W.none));
else{var bx=el('div','boxes');bx.appendChild(box(W.changes,f.changes,f.fromRelease.changes));bx.appendChild(box(W.purpose,f.purpose,f.fromRelease.purpose));bx.appendChild(box(W.verification,f.verification,f.fromRelease.verification));det.appendChild(bx)}
it.appendChild(det);ul.appendChild(it)});
card.appendChild(ul);li.appendChild(card);list.appendChild(li)})}
chips();draw();
window.addEventListener('beforeprint',function(){all(true)});
})();
</script>
</body>
</html>
`;
}
