/**
 * The published page (spec 05): a single index.html that opens in any browser
 * straight from the shared folder. It needs no server and no internet
 * connection, because the data, styles and script are all inside the file.
 */
import {
  LANGUAGES,
  LEVEL_NAME,
  STATUSES,
  brief,
  byPriority,
  deadline,
  flags,
  isClosed,
  shownPriority,
  type Project,
  type Task,
} from '../shared/model';
import { boardSlots, slotOf } from '../shared/board';

export interface SituationEntry {
  at: string;
  handledBy: string;
  doingNow: string;
  nextStep: string;
  nextDate: string | null;
}

export interface PageInput {
  project: Project;
  tasks: Task[];
  /** Recent situation updates per task id, newest first. */
  updates: Record<string, SituationEntry[]>;
  publishedAt: string;
  today: string;
  includeNotes: boolean;
  ownerName?: string;
}

/** The data the page's script works on. Owner-only fields are left out unless chosen. */
export function pageData(input: PageInput) {
  const { project, today } = input;
  const tasks = input.tasks
    .filter((t) => t.fileState !== 'removed')
    .sort(byPriority);
  return {
    project: {
      name: project.name,
      customer: project.customer,
      working: LANGUAGES[project.workingLanguage],
    },
    publishedAt: input.publishedAt,
    asOf: today,
    tasks: tasks.map((t) => {
      const b = brief(t);
      const f = flags(t, today, project.dueSoonDays);
      const d = deadline(t, today, project.dueSoonDays);
      return {
        uid: t.id,
        id: t.customerId,
        col: slotOf(t, project.board),
        handledBy: t.situation.handledBy,
        title: t.titleTranslation || t.titleOriginal,
        orig: t.titleTranslation ? t.titleOriginal : '',
        lang: t.language,
        status: t.status,
        closed: isClosed(t),
        level: shownPriority(t),
        levelName: LEVEL_NAME[shownPriority(t)],
        labels: t.labels,
        deadline: d ? { text: d.text, tone: d.tone } : null,
        overdue: f.overdue,
        difficulties: f.openDifficulties,
        what: b.what,
        where: b.where,
        next: b.next,
        descTr: t.descriptionTranslation,
        descOrig: t.descriptionOriginal,
        updates: (input.updates[t.id] ?? []).slice(0, 3),
        notes: input.includeNotes ? t.notes : '',
      };
    }),
    statuses: STATUSES,
    // The owner's Board columns: hidden status columns left out, own columns included.
    board: boardSlots(project.board).map((s) => ({
      key: s.key,
      name: s.name,
      status: s.status,
      own: s.kind === 'own',
    })),
  };
}

/** Keeps the embedded JSON from closing the script tag or opening a comment. */
const safeJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

export function buildPage(input: PageInput): string {
  const data = pageData(input);
  const title = `${input.project.name} · WorkSync`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="WorkSync">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="head">
    <h1 id="pname"></h1>
    <div class="meta" id="meta"></div>
    <div class="ro">Read-only copy published by WorkSync. Changes made here are not saved.</div>
  </header>
  <div class="tools">
    <label class="search"><span aria-hidden="true">⌕</span><input id="q" type="search" placeholder="Type a task number such as 012, a label, or words from the title" autocomplete="off"></label>
    <label class="sw"><input type="checkbox" id="origFirst"> Original first</label>
  </div>
  <div class="chips" role="group" aria-label="Filter">
    <button data-f="open" aria-pressed="true">All open</button>
    <button data-f="overdue" aria-pressed="false">Overdue</button>
    <button data-f="top" aria-pressed="false">Urgent and high</button>
    <button data-f="all" aria-pressed="false">Everything, with done</button>
  </div>
  <div class="viewbar">
    <div class="views" role="tablist" aria-label="View">
      <button role="tab" data-v="briefs" aria-selected="true">Briefs</button>
      <button role="tab" data-v="board" aria-selected="false">Board</button>
    </div>
    <div id="count" class="count"></div>
  </div>
  <main id="briefs" class="briefs"></main>
  <main id="board" class="board" hidden></main>
  <section class="dash" aria-labelledby="dashTitle">
    <h2 id="dashTitle">Dashboard</h2>
    <div class="tiles" id="tiles"></div>
    <div class="cols"><div><h3>By status</h3><div id="byStatus"></div></div><div><h3>Open tasks by priority</h3><div id="byLevel"></div></div></div>
  </section>
  <footer class="foot" id="foot"></footer>
</div>
<script id="data" type="application/json">${safeJson(data)}</script>
<script>${PAGE_JS}</script>
</body>
</html>
`;
}

const PAGE_CSS = `
:root{color-scheme:dark;--bg:#10141b;--surface:#151a22;--raised:#1c232d;--line:rgba(214,226,255,.09);--line2:rgba(214,226,255,.16);--fg:#e7ebf2;--fg2:#b3bbc8;--muted:#8c96a7;--accent:#45c4d8;--u:#f0524f;--h:#f2b52b;--low:#5a6475}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f7f9;--surface:#fff;--raised:#eef1f5;--line:rgba(20,30,50,.1);--line2:rgba(20,30,50,.18);--fg:#1c1f24;--fg2:#3d4450;--muted:#6b7280;--accent:#0f8ea3}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI","Yu Gothic UI","Hiragino Sans",system-ui,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 48px}.wrap.wide{max-width:1680px}
h1{margin:0;font-size:26px;letter-spacing:-.01em}.meta{color:var(--muted);font-size:13px;margin-top:4px;display:flex;gap:14px;flex-wrap:wrap}.ro{margin-top:10px;font-size:12.5px;color:var(--fg2);padding:8px 10px;border:1px solid var(--line2);border-radius:9px;display:inline-block}
.tools{display:flex;gap:12px;align-items:center;margin:20px 0 10px;flex-wrap:wrap}.search{flex:1 1 320px;display:flex;align-items:center;gap:8px;padding:0 12px;height:42px;border-radius:11px;background:var(--surface);border:1px solid var(--line2)}.search input{flex:1;min-width:0;border:0;background:none;color:var(--fg);font:inherit;outline:none}.search:focus-within{border-color:var(--accent)}
.sw{font-size:13px;color:var(--fg2);display:flex;gap:6px;align-items:center}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips button{height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--line2);background:var(--surface);color:var(--fg2);font-family:inherit;font-size:12.5px;font-weight:500;cursor:pointer}.chips button[aria-pressed=true]{border-color:var(--accent);color:var(--fg);background:color-mix(in srgb,var(--accent) 14%,transparent)}
.count{color:var(--muted);font-size:12.5px}
.viewbar{display:flex;align-items:center;gap:12px;margin:14px 0 10px;flex-wrap:wrap}
.views{display:inline-flex;padding:3px;border-radius:10px;background:var(--surface);border:1px solid var(--line)}.views button{height:30px;padding:0 14px;border:0;border-radius:8px;background:transparent;color:var(--fg2);font:inherit;font-size:13px;font-weight:600;cursor:pointer}.views button[aria-selected=true]{background:var(--raised);color:var(--fg)}
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(230px,1fr);gap:10px;overflow-x:auto;padding-bottom:8px;align-items:start}
.bcol{background:color-mix(in srgb,var(--surface) 60%,transparent);border:1px solid var(--line);border-radius:13px;padding:8px;display:grid;gap:8px;min-width:0}.bcol.own{border-style:dashed}
.bh{display:flex;align-items:center;gap:8px;padding:2px 4px;font-size:13px}.bh .n{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}.bh .st{font-size:11px}
.card{all:unset;box-sizing:border-box;display:grid;gap:5px;padding:10px 11px;border-radius:11px;background:var(--surface);border:1px solid var(--line);border-left:4px solid transparent;cursor:pointer;min-width:0}
.card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.card.U{border-left-color:var(--u)}.card.H{border-left-color:var(--h)}.card.closed{opacity:.7}.card .ttl{margin:0;font-size:13.5px;overflow-wrap:anywhere}.card .no{font-size:14px}.card .who{color:var(--muted);font-size:12px}
.hint{color:var(--muted);font-size:12px;padding:6px 4px}
.briefs{display:grid;gap:10px}
.brief{border:1px solid var(--line);border-left:4px solid transparent;border-radius:13px;background:var(--surface);overflow:hidden}
.brief.U{border-left-color:var(--u);background:linear-gradient(90deg,color-mix(in srgb,var(--u) 12%,transparent),transparent 60%),var(--surface)}
.brief.H{border-left-color:var(--h);background:linear-gradient(90deg,color-mix(in srgb,var(--h) 12%,transparent),transparent 60%),var(--surface)}
.brief.L{opacity:.92}.brief.closed{opacity:.7;border-left-color:var(--line2);background:var(--surface)}
.brief>button{all:unset;display:block;width:100%;box-sizing:border-box;padding:12px 14px;cursor:pointer}.brief>button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.no{font:600 17px ui-monospace,Consolas,monospace}.no small{font-size:11px;color:var(--muted);margin-right:2px}
.tag{font-family:inherit;font-weight:700;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:5px}.tag.U{background:color-mix(in srgb,var(--u) 22%,transparent);color:var(--u)}.tag.H{background:color-mix(in srgb,var(--h) 22%,transparent);color:#c58a00}
@media (prefers-color-scheme:dark){.tag.U{color:#ffb0ae}.tag.H{color:#fbd98a}}
.st,.chip,.label{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line2);color:var(--fg2);white-space:nowrap}.chip.over{font-weight:700;color:var(--fg)}.label::before{content:"#";color:var(--accent);font-weight:700}
.sp{flex:1}.ttl{font-weight:600;font-size:15px;margin-top:6px}.orig{color:var(--muted);font-size:12.5px}
dl{display:grid;grid-template-columns:140px minmax(0,1fr);gap:4px 12px;margin:10px 0 0;font-size:13.5px}dt{color:var(--muted)}dd{margin:0}
@media (max-width:640px){dl{grid-template-columns:minmax(0,1fr)}dd{margin-bottom:6px}}
.more{display:none;padding:0 14px 14px;border-top:1px solid var(--line)}.brief.open .more{display:block}
.more h4{margin:12px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.pairs{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}.pairs p{margin:0;padding:9px 12px;font-size:13.5px;white-space:pre-wrap}.pairs p+p{border-left:1px solid var(--line)}
@media (max-width:640px){.pairs{grid-template-columns:1fr}.pairs p+p{border-left:0;border-top:1px solid var(--line)}}
.upd{font-size:13px;color:var(--fg2);margin:0;padding-left:18px}.upd li{margin-bottom:4px}.upd b{color:var(--fg);font-weight:600}
.dash{margin-top:34px}.dash h2{font-size:19px;margin:0 0 12px}.dash h3{font-size:13px;color:var(--muted);margin:16px 0 8px;font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.tile{padding:12px;border-radius:12px;background:var(--surface);border:1px solid var(--line)}.tile b{display:block;font-size:26px}.tile span{font-size:12px;color:var(--muted)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media (max-width:720px){.cols{grid-template-columns:1fr}}
.bar{display:grid;grid-template-columns:110px 1fr 40px;gap:8px;align-items:center;font-size:13px;margin:5px 0}.bar i{display:block;height:10px;border-radius:5px;background:var(--accent)}
.empty{padding:28px;text-align:center;color:var(--muted);border:1px dashed var(--line2);border-radius:12px}
.foot{margin-top:28px;color:var(--muted);font-size:12px}
@media print{.tools,.chips,.views{display:none}.brief .more{display:block}body{background:#fff;color:#000}}
`;

/** The page's own script: search, filters, opening a brief, and the dashboard. Plain JavaScript, no libraries. */
const PAGE_JS = `
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var fmt=function(iso){var d=new Date(iso);return d.toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})};
var day=function(s){return s?s.replace(/-/g,'/'):''};
$('pname').textContent=D.project.name;document.title=D.project.name+' · WorkSync';
$('meta').innerHTML=(D.project.customer?'<span>'+esc(D.project.customer)+'</span>':'')+'<span>Published '+esc(fmt(D.publishedAt))+'</span><span>Information as of '+esc(day(D.asOf))+'</span>';
var filter='open',origFirst=false,openIds={},view=location.hash==='#board'?'board':'briefs';
var paras=function(s){s=(s||'').trim();if(!s)return[];var b=s.split(/\\n\\s*\\n/);return(b.length>1?b:s.split('\\n')).map(function(x){return x.trim()}).filter(Boolean)};
function matches(t,q){q=q.trim().toLowerCase().replace(/^no\\.?\\s*/,'');if(!q)return true;return[t.id,t.title,t.orig,t.what,t.where,t.next].concat(t.labels).join('\\n').toLowerCase().indexOf(q)>=0}
function pass(t){if(filter==='all')return true;if(t.closed)return false;if(filter==='overdue')return t.overdue;if(filter==='top')return t.level==='U'||t.level==='H';return true}
function card(t){
  var main=origFirst&&t.orig?t.orig:t.title;
  var tag=(t.level==='U'||t.level==='H')&&!t.closed?'<span class="tag '+t.level+'">'+esc(t.levelName)+'</span>':'';
  return '<button class="card '+(t.closed?'closed':t.level)+'" data-uid="'+esc(t.uid)+'" aria-label="Open the brief of No. '+esc(t.id)+', '+esc(t.title)+'">'
    +'<span class="top"><span class="no"><small>No.</small>'+esc(t.id)+'</span><span class="sp"></span>'+tag+'</span>'
    +'<span class="ttl"'+(origFirst&&t.orig?' lang="'+esc(t.lang)+'"':'')+'>'+esc(main)+'</span>'
    +(t.handledBy?'<span class="who">'+esc(t.handledBy)+'</span>':'')
    +'<span class="top">'+(t.deadline&&!t.closed?'<span class="chip '+(t.deadline.tone==='over'?'over':'')+'">'+esc(t.deadline.text)+'</span>':'')+(t.difficulties?'<span class="chip">⚠ '+t.difficulties+'</span>':'')+'</span></button>';
}
function renderBoard(list){
  $('board').innerHTML=D.board.map(function(c){
    var col=list.filter(function(t){return t.col===c.key});
    var closed=c.status==='Done'||c.status==='Cancelled';
    var empty=closed&&filter!=='all'&&!col.length?'<div class="hint">Choose “Everything, with done” to see finished tasks.</div>':'';
    return '<section class="bcol'+(c.own?' own':'')+'" aria-label="'+esc(c.name)+'"><div class="bh"><b>'+esc(c.name)+'</b>'+(c.own?'<span class="st">'+esc(c.status)+'</span>':'')+'<span class="n">'+col.length+'</span></div>'+col.map(card).join('')+empty+'</section>';
  }).join('');
}
function render(){
  var q=$('q').value,list=D.tasks.filter(function(t){return pass(t)&&matches(t,q)});
  $('count').textContent=list.length+' task'+(list.length===1?'':'s');
  $('briefs').hidden=view!=='briefs';$('board').hidden=view!=='board';document.querySelector('.wrap').classList.toggle('wide',view==='board');
  Array.prototype.forEach.call(document.querySelectorAll('[data-v]'),function(b){b.setAttribute('aria-selected',b.getAttribute('data-v')===view?'true':'false')});
  if(view==='board'){renderBoard(list);return}
  if(!list.length){$('briefs').innerHTML='<div class="empty">No task matches'+(q?' “'+esc(q)+'”':'')+'. Try the task number, such as 012.</div>';return}
  $('briefs').innerHTML=list.map(function(t){
    var main=origFirst&&t.orig?t.orig:t.title,sub=origFirst&&t.orig?t.title:t.orig;
    var tag=(t.level==='U'||t.level==='H')&&!t.closed?'<span class="tag '+t.level+'">'+esc(t.levelName)+'</span>':'';
    var chips='<span class="st">'+esc(t.status)+'</span>'+(t.deadline?'<span class="chip '+(t.deadline.tone==='over'?'over':'')+'">'+esc(t.deadline.text)+'</span>':'')+(t.difficulties?'<span class="chip">⚠ '+t.difficulties+' open</span>':'');
    var o=paras(t.descOrig),tr=paras(t.descTr),n=Math.max(o.length,tr.length),desc='';
    if(n){desc='<h4>Description</h4>'+(tr.length?'<div class="pairs">'+Array.from({length:n}).map(function(_,i){var l=origFirst?o:tr,r=origFirst?tr:o;return '<p>'+esc(l[i]||'')+'</p><p>'+esc(r[i]||'')+'</p>'}).join('')+'</div>':'<div class="pairs" style="grid-template-columns:1fr"><p lang="'+esc(t.lang)+'">'+esc(o.join('\\n\\n'))+'</p></div>')}
    var upd=t.updates.length?'<h4>Latest situation updates</h4><ul class="upd">'+t.updates.map(function(u){return '<li><b>'+esc(day(u.at.slice(0,10)))+'</b> · '+esc([u.handledBy,u.doingNow].filter(Boolean).join(': ')||'Confirmed')+(u.nextStep?' · next: '+esc(u.nextStep)+(u.nextDate?' by '+esc(day(u.nextDate)):''):'')+'</li>'}).join('')+'</ul>':'';
    var notes=t.notes?'<h4>Notes</h4><p style="white-space:pre-wrap;margin:0">'+esc(t.notes)+'</p>':'';
    var cls='brief '+(t.closed?'closed':t.level)+(openIds[t.id]?' open':'');
    return '<article class="'+cls+'" data-id="'+esc(t.id)+'"><button aria-expanded="'+(openIds[t.id]?'true':'false')+'"><div class="top"><span class="no"><small>No.</small>'+esc(t.id)+'</span>'+tag+'<span class="sp"></span>'+chips+'</div>'
      +(t.labels.length?'<div class="top" style="margin-top:6px">'+t.labels.map(function(l){return '<span class="label">'+esc(l)+'</span>'}).join('')+'</div>':'')
      +'<div class="ttl"'+(origFirst&&t.orig?' lang="'+esc(t.lang)+'"':'')+'>'+esc(main)+'</div>'+(sub?'<div class="orig">'+esc(sub)+'</div>':'')
      +'<dl><dt>What it is</dt><dd>'+esc(t.what)+'</dd><dt>Where it stands</dt><dd>'+esc(t.where)+'</dd><dt>What happens next</dt><dd><b>'+esc(t.next)+'</b></dd></dl></button>'
      +'<div class="more">'+(desc||upd||notes?desc+upd+notes:'<p style="color:var(--muted)">No description or situation updates.</p>')+'</div></article>';
  }).join('');
}
$('briefs').addEventListener('click',function(e){var b=e.target.closest('.brief>button');if(!b)return;var id=b.parentNode.getAttribute('data-id');openIds[id]=!openIds[id];render()});
$('q').addEventListener('input',render);
Array.prototype.forEach.call(document.querySelectorAll('[data-v]'),function(b){b.addEventListener('click',function(){view=b.getAttribute('data-v');history.replaceState(null,'',view==='board'?'#board':'#');render()})});
// A card on the Board opens its brief.
$('board').addEventListener('click',function(e){var c=e.target.closest('.card');if(!c)return;var uid=c.getAttribute('data-uid');var t=D.tasks.filter(function(x){return x.uid===uid})[0];if(!t)return;openIds[t.id]=true;view='briefs';history.replaceState(null,'','#');render();var el=document.querySelector('.brief[data-id="'+CSS.escape(t.id)+'"]');if(el){el.scrollIntoView({block:'start'});el.querySelector('button').focus({preventScroll:true})}});
$('origFirst').addEventListener('change',function(e){origFirst=e.target.checked;render()});
Array.prototype.forEach.call(document.querySelectorAll('[data-f]'),function(b){b.addEventListener('click',function(){filter=b.getAttribute('data-f');Array.prototype.forEach.call(document.querySelectorAll('[data-f]'),function(x){x.setAttribute('aria-pressed',x===b?'true':'false')});render()})});
var open=D.tasks.filter(function(t){return !t.closed});
var c=function(f){return open.filter(f).length};
$('tiles').innerHTML=[['Open tasks',open.length],['Overdue',c(function(t){return t.overdue})],['Open difficulties',open.reduce(function(n,t){return n+t.difficulties},0)]].map(function(x){return '<div class="tile"><b>'+x[1]+'</b><span>'+esc(x[0])+'</span></div>'}).join('');
var max=function(a){return Math.max.apply(null,[1].concat(a.map(function(x){return x[1]})))};
var bars=function(rows,color){var m=max(rows);return rows.map(function(x){return '<div class="bar"><span>'+esc(x[0])+'</span><i style="width:'+Math.round(x[1]/m*100)+'%;background:'+(color(x[0])||'var(--accent)')+'"></i><b>'+x[1]+'</b></div>'}).join('')};
$('byStatus').innerHTML=bars(D.statuses.map(function(s){return[s,D.tasks.filter(function(t){return t.status===s}).length]}).filter(function(x){return x[1]}),function(){return ''});
$('byLevel').innerHTML=bars([['Urgent','U'],['High','H'],['Normal','N'],['Low','L']].map(function(x){return[x[0],c(function(t){return t.level===x[1]})]}),function(n){return{Urgent:'var(--u)',High:'var(--h)',Low:'var(--low)'}[n]});
$('foot').textContent='Published by WorkSync from the owner’s PC. Notes and personal to-dos are not included'+(D.tasks.some(function(t){return t.notes})?', except notes the owner chose to share':'')+'.';
render();
})();
`;

/** A page in the parent folder linking to each project's published page. */
export function buildIndexPage(
  projects: { name: string; folder: string; publishedAt: string }[],
): string {
  const rows = projects
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (p) =>
        `<li><a href="${escapeHtml(encodeURI(p.folder))}/index.html">${escapeHtml(p.name)}</a><span>Published ${escapeHtml(new Date(p.publishedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span></li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="WorkSync"><title>Projects · WorkSync</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.5 "Segoe UI","Yu Gothic UI",system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 6px}p{opacity:.7;margin:0 0 20px}ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:11px}a{font-weight:600}span{opacity:.7;font-size:13px}</style>
</head><body><main><h1>Projects</h1><p>Read-only copies published by WorkSync.</p><ul>${rows}</ul></main></body></html>
`;
}
