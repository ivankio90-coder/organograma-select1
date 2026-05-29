/* ============================================================
   ORGANOGRAMA SELECT V8
   Hierarquia Dual · Modo Foco Direto · Equipe Direta Clicável
   ============================================================ */
'use strict';

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const API_URL = 'https://script.google.com/macros/s/AKfycbxR4Owe_2Y8p1NZfv4SWAKQUskLiePlU3vN-FIbFcO398pMHH4LVYqSk7PQcP9cu4u-/exec';

// ─── DIMENSÕES ────────────────────────────────────────────────────────────────
const CARD_W       = 190;
const CARD_W_ROOT  = 210;
const CARD_H_SETOR = 155;
const CARD_H_COLAB = 108;
const GAP_H        = 48;
const GAP_V_SETOR  = 80;
const GAP_V_COLAB  = 56;
const TREE_PAD_V   = 40;

// ─── STATUS ───────────────────────────────────────────────────────────────────
const STATUS_COLOR = {
  'Ativo':    '#22C55E',
  'Inativo':  '#9CA3AF',
  'Férias':   '#EAB308',
  'Afastado': '#EF4444',
};

const NODE_SETOR = 'setor';
const NODE_COLAB = 'colab';

// ─── ESTADO ───────────────────────────────────────────────────────────────────
const State = {
  setores:      [],
  colaboradores:[],
  tree:         null,
  nodeMap:      {},
  colabBySetor: {},
  colabMap:     {},
  layout:       {},
  collapsed:    new Set(),
  activeCard:   null,
  focusNode:    null,
  panelHistory: [],
  zoom: 1, panX: 0, panY: 0,
};

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dom = {
  loading:      $('loadingOverlay'),
  world:        $('canvasWorld'),
  container:    $('canvasContainer'),
  svg:          $('connectionsSvg'),
  cards:        $('cardsLayer'),
  panel:        $('sidePanel'),
  panelClose:   $('panelClose'),
  panelContent: $('panelContent'),
  panelColabs:  $('panelColaboradores'),
  colabsList:   $('colaboradoresList'),
  overlay:      $('panelOverlay'),
  searchInput:  $('globalSearch'),
  searchDrop:   $('searchDropdown'),
  zoomLabel:    $('zoomLabel'),
  breadcrumb:   $('breadcrumb'),
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  applyLogo();
  try {
    bootstrap(await fetchData());
  } catch (err) {
    console.warn('[Organograma] API indisponível — demo.', err.message);
    bootstrap(getMockData());
  }
}

function applyLogo() {
  if (typeof LOGO_SRC === 'undefined') return;
  ['headerLogo', 'loadingLogo'].forEach(id => { const el=$(id); if(el) el.src=LOGO_SRC; });
}

function bootstrap(data) {
  processData(data);
  buildDualTree();
  // Inicia com tudo recolhido — apenas o card raiz visível
  const visit = n => {
    if (n.children.length > 0 && n.parent !== null) State.collapsed.add(n.id);
    n.children.forEach(visit);
  };
  if (State.tree) visit(State.tree);
  reflow();
  renderAll();
  initInteractions();
  hideLoading();
}

// ─── FETCH ────────────────────────────────────────────────────────────────────
async function fetchData() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(API_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ─── PROCESS DATA ─────────────────────────────────────────────────────────────
function processData(data) {
  State.setores       = data.setores       || [];
  State.colaboradores = data.colaboradores || [];

  State.colabMap = {};
  State.colaboradores.forEach(c => { State.colabMap[c.ID_COLABORADOR] = c; });

  State.colabBySetor = {};
  State.colaboradores.forEach(c => {
    if (!c.SETOR_ID) return;
    if (!State.colabBySetor[c.SETOR_ID]) State.colabBySetor[c.SETOR_ID] = [];
    State.colabBySetor[c.SETOR_ID].push(c);
  });

  State.colaboradores.forEach(c => {
    if (c.GESTOR_DIRETO && !State.colabMap[c.GESTOR_DIRETO]) {
      console.warn(`[Organograma] Gestor não encontrado: "${c.NOME_COMPLETO}" (${c.ID_COLABORADOR}) → gestor "${c.GESTOR_DIRETO}"`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BUILD DUAL TREE
// ═══════════════════════════════════════════════════════════════════════════════
function buildDualTree() {
  State.nodeMap = {};
  const setorNodes = {};

  State.setores.forEach(s => {
    const n = { id:s.ID_SETOR, type:NODE_SETOR, data:s, children:[], parent:null, _subW:0, _x:0, _y:0 };
    setorNodes[s.ID_SETOR] = n;
    State.nodeMap[s.ID_SETOR] = n;
  });

  let root = null;
  State.setores.forEach(s => {
    const n = setorNodes[s.ID_SETOR];
    if (s.SETOR_PAI && setorNodes[s.SETOR_PAI]) {
      n.parent = setorNodes[s.SETOR_PAI];
      setorNodes[s.SETOR_PAI].children.push(n);
    } else { root = n; }
  });

  State.setores.forEach(s => {
    const colabs = State.colabBySetor[s.ID_SETOR] || [];
    if (!colabs.length) return;
    const sn = setorNodes[s.ID_SETOR];
    const cnMap = {};

    colabs.forEach(c => {
      const cn = { id:c.ID_COLABORADOR, type:NODE_COLAB, data:c, children:[], parent:null, setorNode:sn, _subW:0, _x:0, _y:0 };
      cnMap[c.ID_COLABORADOR] = cn;
      State.nodeMap[c.ID_COLABORADOR] = cn;
    });

    const roots = [];
    colabs.forEach(c => {
      const cn = cnMap[c.ID_COLABORADOR];
      if (c.GESTOR_DIRETO && cnMap[c.GESTOR_DIRETO]) {
        cn.parent = cnMap[c.GESTOR_DIRETO];
        cnMap[c.GESTOR_DIRETO].children.push(cn);
      } else { roots.push(cn); }
    });

    roots.sort((a,b) => cargoRank(a.data.CARGO) - cargoRank(b.data.CARGO));
    const sortCC = n => { n.children.sort((a,b) => cargoRank(a.data.CARGO)-cargoRank(b.data.CARGO)); n.children.forEach(sortCC); };
    roots.forEach(sortCC);
    roots.forEach(cn => { cn.parent = sn; sn.children.unshift(cn); });
  });

  const sortSC = n => {
    const cp = n.children.filter(c => c.type===NODE_COLAB);
    const sp = n.children.filter(c => c.type===NODE_SETOR);
    sp.sort((a,b) => (a.data.ORDEM||99)-(b.data.ORDEM||99));
    n.children = [...cp, ...sp];
    sp.forEach(sortSC);
  };
  if (root) sortSC(root);
  State.tree = root;
}

function cargoRank(c) {
  if (!c) return 99;
  c = c.toLowerCase();
  if (c.includes('presidente'))      return 1;
  if (c.includes('diretor'))         return 2;
  if (c.includes('superintendente')) return 3;
  if (c.includes('gerente'))         return 4;
  if (c.includes('coordenador'))     return 5;
  if (c.includes('supervisor'))      return 6;
  if (c.includes('analista'))        return 7;
  if (c.includes('assistente'))      return 8;
  if (c.includes('auxiliar'))        return 9;
  return 10;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MODO FOCO
// ═══════════════════════════════════════════════════════════════════════════════
function enterFocus(node) {
  State.focusNode = node;
  State.collapsed.clear();
  reflow();
  renderAll();
  updateBreadcrumb();
  requestAnimationFrame(() => {
    const pos = State.layout[node.id];
    if (!pos) return;
    const vpW = dom.container.clientWidth;
    const targetZoom = Math.min(1.1, (vpW - 60) / (node._subW || CARD_W));
    animatePan(vpW/2 - (pos.x + pos.w/2)*targetZoom, 30, targetZoom, 420);
  });
}

function exitFocus() {
  State.focusNode = null;
  reflow();
  renderAll();
  updateBreadcrumb();
}

function updateBreadcrumb() {
  if (!dom.breadcrumb) return;
  if (!State.focusNode) { dom.breadcrumb.classList.add('hidden'); return; }

  const trail = [];
  let cur = State.focusNode;
  while (cur) { if (cur.type===NODE_SETOR) trail.unshift(cur); cur=cur.parent; }

  const crumbs = trail.map((n,i) =>
    i===trail.length-1
      ? `<span class="bc-current">${escHtml(n.data.NOME_SETOR)}</span>`
      : `<span class="bc-link" data-node-id="${n.id}">${escHtml(n.data.NOME_SETOR)}</span><span class="bc-sep">›</span>`
  ).join('');

  dom.breadcrumb.innerHTML = `
    <button class="bc-back" id="bcBack">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><polyline points="15 18 9 12 15 6"/></svg>
      Visão Geral
    </button>
    <div class="bc-trail">${crumbs}</div>`;
  dom.breadcrumb.classList.remove('hidden');

  $('bcBack').addEventListener('click', exitFocus);
  dom.breadcrumb.querySelectorAll('.bc-link').forEach(el =>
    el.addEventListener('click', () => { const n=State.nodeMap[el.dataset.nodeId]; if(n) enterFocus(n); })
  );
}

function animatePan(tx, ty, tz, dur) {
  const sx=State.panX, sy=State.panY, sz=State.zoom, t0=performance.now();
  const frame = now => {
    const t = Math.min(1,(now-t0)/dur);
    const e = t<0.5 ? 2*t*t : -1+(4-2*t)*t;
    State.panX=sx+(tx-sx)*e; State.panY=sy+(ty-sy)*e; State.zoom=sz+(tz-sz)*e;
    applyTransform();
    if (t<1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LAYOUT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const cardH = n => n.type===NODE_COLAB ? CARD_H_COLAB : CARD_H_SETOR;
const cardW = n => (n.type===NODE_SETOR && n.data.NIVEL===1) ? CARD_W_ROOT : CARD_W;
const gapV  = n => n.type===NODE_COLAB ? GAP_V_COLAB : GAP_V_SETOR;
const renderRoot = () => State.focusNode || State.tree;

function measureSubtree(n) {
  const cw = cardW(n);
  if (State.collapsed.has(n.id) || !n.children.length) { n._subW=cw; return cw; }
  let tot=0;
  n.children.forEach((c,i) => { tot+=measureSubtree(c); if(i<n.children.length-1) tot+=GAP_H; });
  n._subW=Math.max(cw,tot);
  return n._subW;
}

function placeNodes(n, left, y) {
  const cw=cardW(n), ch=cardH(n), cx=left+(n._subW-cw)/2;
  n._x=cx; n._y=y;
  State.layout[n.id]={x:cx,y,w:cw,h:ch};
  if (State.collapsed.has(n.id)||!n.children.length) return;
  let cl=left;
  n.children.forEach(c => { placeNodes(c,cl,y+ch+gapV(n)); cl+=c._subW+GAP_H; });
}

function computeBounds() {
  let minX=Infinity,maxX=-Infinity,maxY=-Infinity;
  const visit = n => {
    const p=State.layout[n.id];
    if(p){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x+p.w);maxY=Math.max(maxY,p.y+p.h);}
    if(!State.collapsed.has(n.id)) n.children.forEach(visit);
  };
  visit(renderRoot());
  return {minX,maxX,maxY};
}

function reflow() {
  const root=renderRoot();
  if (!root) return;
  State.layout={};
  measureSubtree(root);
  placeNodes(root,0,TREE_PAD_V);
  const {minX,maxX,maxY}=computeBounds();
  if (minX<0) {
    const shift=-minX+40;
    const visit=n=>{const p=State.layout[n.id];if(p){p.x+=shift;n._x+=shift;}n.children.forEach(visit);};
    visit(root);
  }
  const tW=(maxX-Math.min(0,minX))+80, tH=maxY+100;
  dom.world.style.width=tW+'px';
  dom.world.style.height=tH+'px';
  if (!State.focusNode) {
    const vpW=dom.container.clientWidth, vpH=dom.container.clientHeight;
    State.zoom=Math.min(1,(vpW-40)/tW,(vpH-40)/tH);
    State.panX=Math.max(0,(vpW-tW*State.zoom)/2);
    State.panY=20;
    applyTransform();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════════════════════════
function renderAll() { renderCards(); renderConnections(); }

function renderCards() {
  const frag=document.createDocumentFragment();
  let delay=0;
  const traverse = n => {
    const pos=State.layout[n.id];
    if (!pos) return;
    const el=n.type===NODE_COLAB ? buildColabCard(n,pos) : buildSetorCard(n,pos);
    el.style.animationDelay=Math.min(delay*28,500)+'ms';
    frag.appendChild(el);
    delay++;
    if (!State.collapsed.has(n.id)) n.children.forEach(traverse);
  };
  traverse(renderRoot());
  dom.cards.innerHTML='';
  dom.cards.appendChild(frag);
}

// ─── CARD SETOR ───────────────────────────────────────────────────────────────
function buildSetorCard(node, pos) {
  const setor=node.data;
  const level=setor.NIVEL||1;
  const hasKids=node.children.length>0;
  const isCollapsed=State.collapsed.has(node.id);
  const totalColabs=countColabsInBranch(node);
  const manager=findSectorManager(node);

  const avatarInner=manager?.FOTO_URL
    ? `<img src="${escHtml(manager.FOTO_URL)}" alt="${escHtml(manager.NOME_COMPLETO)}" loading="lazy"/>`
    : manager
      ? `<span>${getInitials(manager.NOME_COMPLETO)}</span>`
      : `<span>${setor.NOME_SETOR.slice(0,2).toUpperCase()}</span>`;

  const div=document.createElement('div');
  div.className=`sector-card setor-node level-${level}`;
  div.dataset.nodeId=node.id;
  div.dataset.nodeType=NODE_SETOR;
  div.style.cssText=`left:${pos.x}px;top:${pos.y}px;width:${pos.w}px;height:${pos.h}px`;

  div.innerHTML=`
    <div class="card-top-bar"></div>
    <div class="card-body">
      <div class="card-sector-name">${escHtml(setor.NOME_SETOR)}</div>
      <div class="card-avatar">${avatarInner}</div>
      ${manager?`
        <div class="card-manager-name">${escHtml(manager.NOME_COMPLETO)}</div>
        <div class="card-manager-role">${escHtml(manager.CARGO)}</div>
      `:`<div class="card-no-manager">Sem gestor</div>`}
    </div>
    <div class="card-footer">
      <svg class="card-count-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      <span class="card-count">${totalColabs} colab${totalColabs!==1?'s':''}</span>
    </div>
    ${hasKids?`
      <div class="card-toggle${isCollapsed?' collapsed':''}" data-node-id="${node.id}" title="${isCollapsed?'Expandir':'Recolher'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </div>`:``}
  `;

  // Clique simples → entra em modo foco E abre painel
  div.addEventListener('click', e => {
    if (e.target.closest('.card-toggle')) return;
    setActiveCard(node.id);
    openSetorPanel(node);
    if (hasKids && State.focusNode?.id !== node.id) {
      enterFocus(node);
    }
  });

  const toggle=div.querySelector('.card-toggle');
  if (toggle) toggle.addEventListener('click', e => { e.stopPropagation(); toggleCollapse(node.id); });
  return div;
}

// ─── CARD COLAB ───────────────────────────────────────────────────────────────
function buildColabCard(node, pos) {
  const colab=node.data;
  const hasKids=node.children.length>0;
  const isCollapsed=State.collapsed.has(node.id);
  const sc=STATUS_COLOR[colab.STATUS]||'#9CA3AF';

  const avatarInner=colab.FOTO_URL
    ? `<img src="${escHtml(colab.FOTO_URL)}" alt="${escHtml(colab.NOME_COMPLETO)}" loading="lazy"/>`
    : `<span>${getInitials(colab.NOME_COMPLETO)}</span>`;

  const div=document.createElement('div');
  div.className='sector-card colab-node';
  div.dataset.nodeId=node.id;
  div.dataset.nodeType=NODE_COLAB;
  div.style.cssText=`left:${pos.x}px;top:${pos.y}px;width:${pos.w}px;height:${pos.h}px`;

  div.innerHTML=`
    <div class="card-top-bar colab-bar"></div>
    <div class="card-body colab-body">
      <div class="card-avatar colab-avatar-sm">${avatarInner}</div>
      <div class="colab-info-block">
        <div class="card-manager-name">${escHtml(colab.NOME_COMPLETO)}</div>
        <div class="card-manager-role">${escHtml(colab.CARGO||'')}</div>
        <div class="colab-status-badge">
          <span class="status-dot-inline" style="background:${sc}"></span>
          <span class="status-text">${escHtml(colab.STATUS||'')}</span>
        </div>
      </div>
    </div>
    ${hasKids?`
      <div class="card-toggle${isCollapsed?' collapsed':''}" data-node-id="${node.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </div>`:``}
  `;

  div.addEventListener('click', e => {
    if (e.target.closest('.card-toggle')) return;
    openColabPanel(colab, node.setorNode);
    setActiveCard(node.id);
  });

  const toggle=div.querySelector('.card-toggle');
  if (toggle) toggle.addEventListener('click', e => { e.stopPropagation(); toggleCollapse(node.id); });
  return div;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function findSectorManager(sn) {
  const dc=sn.children.filter(c=>c.type===NODE_COLAB);
  if (!dc.length) return null;
  return dc.slice().sort((a,b)=>cargoRank(a.data.CARGO)-cargoRank(b.data.CARGO))[0].data;
}

function countColabsInBranch(sn) {
  let n=0;
  const v=node=>{if(node.type===NODE_COLAB)n++;node.children.forEach(v);};
  sn.children.forEach(v);
  return n;
}

function countSubSetores(sn) {
  let n=0;
  const v=node=>{if(node.type===NODE_SETOR){n++;node.children.forEach(v);}};
  sn.children.filter(c=>c.type===NODE_SETOR).forEach(v);
  return n;
}

function getAllColabsInBranch(sn) {
  const list=[];
  const v=n=>{if(n.type===NODE_COLAB)list.push(n.data);n.children.forEach(v);};
  sn.children.forEach(v);
  return list;
}

// Colaboradores que reportam DIRETAMENTE a este colab
function getEquipeDireta(colabId) {
  return State.colaboradores.filter(c => c.GESTOR_DIRETO === colabId);
}

// ─── CONNECTIONS ──────────────────────────────────────────────────────────────
function renderConnections() {
  const frag=document.createDocumentFragment();
  const traverse=n=>{
    if(State.collapsed.has(n.id)||!n.children.length) return;
    const pp=State.layout[n.id]; if(!pp) return;
    const pbx=pp.x+pp.w/2, pby=pp.y+pp.h, my=pby+gapV(n)*0.42;
    frag.appendChild(makeLine(pbx,pby,pbx,my));
    const vk=n.children.filter(k=>State.layout[k.id]);
    if(vk.length>1){
      frag.appendChild(makeLine(
        State.layout[vk[0].id].x+State.layout[vk[0].id].w/2,my,
        State.layout[vk[vk.length-1].id].x+State.layout[vk[vk.length-1].id].w/2,my
      ));
    }
    vk.forEach(child=>{
      const cp=State.layout[child.id];
      frag.appendChild(makeLine(cp.x+cp.w/2,my,cp.x+cp.w/2,cp.y));
      traverse(child);
    });
  };
  traverse(renderRoot());
  dom.svg.innerHTML='';
  dom.svg.appendChild(frag);
}

function makeLine(x1,y1,x2,y2){
  const l=document.createElementNS('http://www.w3.org/2000/svg','line');
  l.setAttribute('x1',x1);l.setAttribute('y1',y1);l.setAttribute('x2',x2);l.setAttribute('y2',y2);
  l.setAttribute('class','connector-line');
  return l;
}

// ─── COLLAPSE ─────────────────────────────────────────────────────────────────
function toggleCollapse(id){
  if(State.collapsed.has(id))State.collapsed.delete(id);else State.collapsed.add(id);
  reflow();renderAll();
}
function expandAll(){State.collapsed.clear();reflow();renderAll();}
function collapseAll(){
  State.collapsed.clear();
  const v=n=>{if(n.children.length>0&&n.parent!==null)State.collapsed.add(n.id);n.children.forEach(v);};
  v(State.tree);reflow();renderAll();
}

function setActiveCard(id){
  document.querySelectorAll('.sector-card.active').forEach(el=>el.classList.remove('active'));
  if(id){const el=document.querySelector(`[data-node-id="${id}"]`);if(el)el.classList.add('active');}
  State.activeCard=id;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PAINEL — SETOR
// ═══════════════════════════════════════════════════════════════════════════════
function openSetorPanel(node) {
  State.panelHistory=[];
  _renderSetorPanel(node);
  openPanel();
}

function _renderSetorPanel(node) {
  const setor=node.data;
  const manager=findSectorManager(node);
  const colabs=getAllColabsInBranch(node);
  const subCount=countSubSetores(node);
  const pai=node.parent?.type===NODE_SETOR?node.parent.data:null;

  const mgrAv=manager
    ? (manager.FOTO_URL?`<img src="${escHtml(manager.FOTO_URL)}" alt="${escHtml(manager.NOME_COMPLETO)}"/>`:`<span>${getInitials(manager.NOME_COMPLETO)}</span>`)
    : `<span>${setor.NOME_SETOR.slice(0,2).toUpperCase()}</span>`;

  dom.panelContent.innerHTML=`
    <div class="panel-hero setor-hero">
      <div class="setor-hero-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="26" height="26">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
      </div>
      <div class="panel-hero-info">
        <div class="panel-setor-label">SETOR</div>
        <div class="panel-name">${escHtml(setor.NOME_SETOR)}</div>
        ${pai?`<div class="panel-setor-pai" data-setor-id="${node.parent.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><polyline points="15 18 9 12 15 6"/></svg>
          ${escHtml(pai.NOME_SETOR)}
        </div>`:''}
      </div>
    </div>

    <div class="panel-metrics">
      <div class="metric-card"><div class="metric-value">${colabs.length}</div><div class="metric-label">Colaboradores</div></div>
      ${subCount>0?`<div class="metric-card"><div class="metric-value">${subCount}</div><div class="metric-label">Sub-setores</div></div>`:''}
    </div>

    ${manager?`
    <div class="panel-section-block">
      <div class="panel-block-title">Gestor Responsável</div>
      <div class="panel-manager-row" data-colab-id="${manager.ID_COLABORADOR}">
        <div class="panel-mgr-avatar">${mgrAv}</div>
        <div class="panel-mgr-info">
          <div class="panel-mgr-name">${escHtml(manager.NOME_COMPLETO)}</div>
          <div class="panel-mgr-role">${escHtml(manager.CARGO)}</div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="color:var(--text-muted);flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>`:``}
  `;

  // Pai clicável
  const paiEl=dom.panelContent.querySelector('.panel-setor-pai');
  if(paiEl){
    paiEl.style.cursor='pointer';
    paiEl.addEventListener('click',()=>{const pn=State.nodeMap[paiEl.dataset.setorId];if(pn){State.panelHistory.push(node);_renderSetorPanel(pn);}});
  }

  // Gestor clicável
  const mgrRow=dom.panelContent.querySelector('.panel-manager-row');
  if(mgrRow){
    mgrRow.addEventListener('click',()=>{
      const c=State.colabMap[mgrRow.dataset.colabId];
      if(c){State.panelHistory.push(node);_renderColabPanel(c,node);}
    });
  }

  // Lista completa da equipe
  if(colabs.length>0){
    dom.panelColabs.style.display='block';
    dom.colabsList.innerHTML=colabs.map(buildColabItem).join('');
    dom.colabsList.querySelectorAll('.colaborador-item').forEach(item=>{
      item.addEventListener('click',()=>{
        const c=State.colabMap[item.dataset.colabId];
        if(c){State.panelHistory.push(node);_renderColabPanel(c,node);}
      });
    });
  } else {
    dom.panelColabs.style.display='none';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PAINEL — COLABORADOR (com Equipe Direta)
// ═══════════════════════════════════════════════════════════════════════════════
function openColabPanel(colab, setorNode) {
  State.panelHistory=[];
  _renderColabPanel(colab, setorNode);
  openPanel();
}

function _renderColabPanel(colab, setorNode) {
  const sc=STATUS_COLOR[colab.STATUS]||'#9CA3AF';
  const avatarInner=colab.FOTO_URL
    ? `<img src="${escHtml(colab.FOTO_URL)}" alt="${escHtml(colab.NOME_COMPLETO)}"/>`
    : `<span>${getInitials(colab.NOME_COMPLETO)}</span>`;

  const gestor=colab.GESTOR_DIRETO?State.colabMap[colab.GESTOR_DIRETO]:null;
  const setor=State.nodeMap[colab.SETOR_ID]?.data;
  const equipeDireta=getEquipeDireta(colab.ID_COLABORADOR);
  const canBack=State.panelHistory.length>0;

  dom.panelContent.innerHTML=`
    ${canBack?`<div class="panel-back-row">
      <button class="panel-back-btn" id="panelBackBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><polyline points="15 18 9 12 15 6"/></svg>
        Voltar
      </button>
    </div>`:''}
    <div class="panel-hero">
      <div class="panel-avatar">${avatarInner}</div>
      <div class="panel-hero-info">
        <div class="panel-name">${escHtml(colab.NOME_COMPLETO)}</div>
        <div class="panel-role">${escHtml(colab.CARGO||'')}</div>
        <div class="panel-status">
          <span class="status-dot" style="background:${sc}"></span>
          ${escHtml(colab.STATUS||'Ativo')}
        </div>
      </div>
    </div>
    <div class="panel-fields">
      ${setor?fieldRow('building','Setor',escHtml(setor.NOME_SETOR)):''}
      ${gestor?`<div class="panel-field">
        ${fieldIcon('user-check')}
        <div class="panel-field-content">
          <div class="panel-field-label">Gestor Direto</div>
          <div class="panel-field-value clickable" data-colab-id="${gestor.ID_COLABORADOR}">${escHtml(gestor.NOME_COMPLETO)}</div>
        </div>
      </div>`:''}
      ${colab.EMAIL?fieldRow('mail','E-mail',`<a href="mailto:${escHtml(colab.EMAIL)}">${escHtml(colab.EMAIL)}</a>`):''}
      ${colab.TELEFONE?fieldRow('phone','Telefone',escHtml(colab.TELEFONE)):''}
      ${colab.RAMAL?fieldRow('hash','Ramal',escHtml(colab.RAMAL)):''}
      ${(colab.CIDADE&&colab.ESTADO)?fieldRow('map-pin','Localização',`${escHtml(colab.CIDADE)} — ${escHtml(colab.ESTADO)}`):''}
      ${colab.AREA_ATUACAO?fieldRow('globe','Área de Atuação',escHtml(colab.AREA_ATUACAO)):''}
      ${colab.DATA_ADMISSAO?fieldRow('calendar','Admissão',formatDate(colab.DATA_ADMISSAO)):''}
    </div>

    ${equipeDireta.length>0?`
    <div class="panel-section-block equipe-direta-block">
      <div class="panel-block-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Equipe Direta (${equipeDireta.length})
      </div>
      <div class="equipe-direta-list">
        ${equipeDireta.map(c=>{
          const esc=STATUS_COLOR[c.STATUS]||'#9CA3AF';
          const av=c.FOTO_URL
            ? `<img src="${escHtml(c.FOTO_URL)}" loading="lazy"/>`
            : `<span>${getInitials(c.NOME_COMPLETO)}</span>`;
          return `<div class="equipe-direta-item" data-colab-id="${c.ID_COLABORADOR}">
            <div class="ed-avatar">${av}</div>
            <div class="ed-info">
              <div class="ed-name">${escHtml(c.NOME_COMPLETO)}</div>
              <div class="ed-role">${escHtml(c.CARGO||'')}</div>
            </div>
            <div class="ed-status-dot" style="background:${esc}"></div>
            <svg class="ed-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="9 18 15 12 9 6"/></svg>
          </div>`;
        }).join('')}
      </div>
    </div>`:``}
  `;

  dom.panelColabs.style.display='none';

  // Botão voltar
  const bb=$('panelBackBtn');
  if(bb){
    bb.addEventListener('click',()=>{
      const prev=State.panelHistory.pop();
      if(prev){
        if(prev.type===NODE_SETOR) _renderSetorPanel(prev);
        else{const c=State.colabMap[prev.id];if(c)_renderColabPanel(c,null);}
      }
    });
  }

  // Gestor clicável
  const ge=dom.panelContent.querySelector('[data-colab-id]');
  if(ge){
    ge.addEventListener('click',()=>{
      const g=State.colabMap[ge.dataset.colabId];
      if(g){State.panelHistory.push({type:NODE_COLAB,id:colab.ID_COLABORADOR});_renderColabPanel(g,setorNode);}
    });
  }

  // Equipe direta — cada item navega até o card + abre painel
  dom.panelContent.querySelectorAll('.equipe-direta-item').forEach(item=>{
    item.addEventListener('click',()=>{
      const cid=item.dataset.colabId;
      const c=State.colabMap[cid];
      if(!c) return;
      State.panelHistory.push({type:NODE_COLAB,id:colab.ID_COLABORADOR});
      _renderColabPanel(c, setorNode);

      // Navega até o card na tela
      const node=State.nodeMap[cid];
      if(node){
        ensureVisible(cid);
        centerOn(cid);
      }
    });
  });
}

// ─── PANEL HELPERS ────────────────────────────────────────────────────────────
function fieldRow(icon,label,value){
  return `<div class="panel-field">${fieldIcon(icon)}<div class="panel-field-content"><div class="panel-field-label">${label}</div><div class="panel-field-value">${value}</div></div></div>`;
}
function fieldIcon(name){
  const p={
    'building':   '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    'user-check': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
    'users':      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'mail':       '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    'phone':      '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.41 2 2 0 0 1 3.6 1.21h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    'hash':       '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    'map-pin':    '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    'globe':      '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    'calendar':   '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  };
  return `<div class="panel-field-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${p[name]||p['building']}</svg></div>`;
}

function buildColabItem(c){
  const sc=STATUS_COLOR[c.STATUS]||'#9CA3AF';
  const av=c.FOTO_URL?`<img src="${escHtml(c.FOTO_URL)}" loading="lazy"/>`:`<span>${getInitials(c.NOME_COMPLETO)}</span>`;
  return `<div class="colaborador-item" data-colab-id="${c.ID_COLABORADOR}">
    <div class="colab-avatar">${av}</div>
    <div class="colab-info"><div class="colab-name">${escHtml(c.NOME_COMPLETO)}</div><div class="colab-role">${escHtml(c.CARGO||'')}</div></div>
    <div class="colab-status" style="background:${sc}"></div>
  </div>`;
}

function openPanel(){dom.panel.classList.add('open');dom.overlay.classList.remove('hidden');}
function closePanel(){dom.panel.classList.remove('open');dom.overlay.classList.add('hidden');State.panelHistory=[];setActiveCard(null);}

// ─── SEARCH ──────────────────────────────────────────────────────────────────
function initSearch(){
  dom.searchInput.addEventListener('input',handleSearch);
  document.addEventListener('click',e=>{
    if(!dom.searchDrop.contains(e.target)&&e.target!==dom.searchInput) dom.searchDrop.classList.add('hidden');
  });
  dom.searchInput.addEventListener('keydown',e=>{ if(e.key==='Escape'){dom.searchDrop.classList.add('hidden');dom.searchInput.blur();} });
}

function handleSearch(){
  const q=dom.searchInput.value.trim().toLowerCase();
  if(q.length<2){dom.searchDrop.classList.add('hidden');return;}

  const cr=State.colaboradores.filter(c=>
    [c.NOME_COMPLETO,c.CARGO,c.EMAIL,c.CIDADE,c.ESTADO,c.AREA_ATUACAO].some(v=>v&&v.toLowerCase().includes(q))
  ).slice(0,7);

  const sr=State.setores.filter(s=>s.NOME_SETOR&&s.NOME_SETOR.toLowerCase().includes(q)).slice(0,3);

  if(!cr.length&&!sr.length){
    dom.searchDrop.innerHTML=`<div style="padding:12px 14px;font-size:12.5px;color:var(--text-muted)">Nenhum resultado</div>`;
    dom.searchDrop.classList.remove('hidden');return;
  }

  let html='';
  cr.forEach(c=>{
    const sc=STATUS_COLOR[c.STATUS]||'#9CA3AF';
    const sn=c.SETOR_ID&&State.nodeMap[c.SETOR_ID]?State.nodeMap[c.SETOR_ID].data.NOME_SETOR:'';
    html+=`<div class="search-item" data-colab-id="${c.ID_COLABORADOR}" data-setor-id="${c.SETOR_ID||''}">
      <div class="search-item-avatar">${c.FOTO_URL?`<img src="${escHtml(c.FOTO_URL)}"/>`:''+getInitials(c.NOME_COMPLETO)}</div>
      <div class="search-item-info"><div class="search-item-name">${escHtml(c.NOME_COMPLETO)}</div><div class="search-item-meta">${escHtml(c.CARGO||'')}${sn?' · '+escHtml(sn):''}</div></div>
      <div class="search-item-status" style="background:${sc}"></div>
    </div>`;
  });
  sr.forEach(s=>{
    const n=State.nodeMap[s.ID_SETOR];
    const tot=n?countColabsInBranch(n):0;
    html+=`<div class="search-item" data-setor-id="${s.ID_SETOR}">
      <div class="search-item-avatar" style="font-size:10px">${s.NOME_SETOR.slice(0,2).toUpperCase()}</div>
      <div class="search-item-info"><div class="search-item-name">${escHtml(s.NOME_SETOR)}</div><div class="search-item-meta">Setor · ${tot} colab${tot!==1?'s':''}</div></div>
    </div>`;
  });

  dom.searchDrop.innerHTML=html;
  dom.searchDrop.classList.remove('hidden');

  dom.searchDrop.querySelectorAll('.search-item').forEach(item=>{
    item.addEventListener('click',()=>{
      dom.searchInput.value='';dom.searchDrop.classList.add('hidden');
      const cid=item.dataset.colabId, sid=item.dataset.setorId;
      if(cid){
        const c=State.colabMap[cid];
        if(c){State.panelHistory=[];openColabPanel(c,State.nodeMap[c.SETOR_ID]);}
        ensureVisible(cid);centerOn(cid);
      } else if(sid){
        const n=State.nodeMap[sid];
        if(n){State.panelHistory=[];openSetorPanel(n);}
        ensureVisible(sid);centerOn(sid);
      }
    });
  });
}

function ensureVisible(nodeId){
  const node=State.nodeMap[nodeId]; if(!node) return;
  if(State.focusNode){
    let inFocus=false,cur=node;
    while(cur){if(cur.id===State.focusNode.id){inFocus=true;break;}cur=cur.parent;}
    if(!inFocus) exitFocus();
  }
  let changed=false,cur=node.parent;
  while(cur){if(State.collapsed.has(cur.id)){State.collapsed.delete(cur.id);changed=true;}cur=cur.parent;}
  if(changed){reflow();renderAll();}
}

function centerOn(nodeId){
  const pos=State.layout[nodeId]; if(!pos) return;
  const vpW=dom.container.clientWidth,vpH=dom.container.clientHeight;
  animatePan(vpW/2-(pos.x+pos.w/2)*State.zoom, vpH/2-(pos.y+pos.h/2)*State.zoom, State.zoom, 350);
  document.querySelectorAll('.sector-card.highlighted').forEach(el=>el.classList.remove('highlighted'));
  const el=document.querySelector(`[data-node-id="${nodeId}"]`);
  if(el){el.classList.add('highlighted');setTimeout(()=>el.classList.remove('highlighted'),3000);}
}

// ─── ZOOM & PAN ──────────────────────────────────────────────────────────────
function initZoomPan(){
  $('btnZoomIn').addEventListener('click',()=>zoomBy(0.12));
  $('btnZoomOut').addEventListener('click',()=>zoomBy(-0.12));
  $('btnZoomReset').addEventListener('click',()=>{State.focusNode=null;updateBreadcrumb();reflow();});

  dom.container.addEventListener('wheel',e=>{
    e.preventDefault();
    const r=dom.container.getBoundingClientRect();
    zoomAt(e.deltaY<0?0.07:-0.07,e.clientX-r.left,e.clientY-r.top);
  },{passive:false});

  let drag=false,sx=0,sy=0,spx=0,spy=0;
  dom.container.addEventListener('mousedown',e=>{
    if(e.button!==0||e.target.closest('.sector-card')||e.target.closest('.card-toggle'))return;
    drag=true;sx=e.clientX;sy=e.clientY;spx=State.panX;spy=State.panY;
    dom.container.classList.add('grabbing');
  });
  document.addEventListener('mousemove',e=>{if(!drag)return;State.panX=spx+(e.clientX-sx);State.panY=spy+(e.clientY-sy);applyTransform();});
  document.addEventListener('mouseup',()=>{drag=false;dom.container.classList.remove('grabbing');});

  let t0=null,tpx=0,tpy=0,ld=0;
  dom.container.addEventListener('touchstart',e=>{
    if(e.touches.length===1){t0=e.touches[0];tpx=State.panX;tpy=State.panY;}
    else if(e.touches.length===2)ld=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  },{passive:true});
  dom.container.addEventListener('touchmove',e=>{
    if(e.touches.length===1&&t0){State.panX=tpx+(e.touches[0].clientX-t0.clientX);State.panY=tpy+(e.touches[0].clientY-t0.clientY);applyTransform();}
    else if(e.touches.length===2){
      const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      const cx=(e.touches[0].clientX+e.touches[1].clientX)/2,cy=(e.touches[0].clientY+e.touches[1].clientY)/2;
      const r=dom.container.getBoundingClientRect();
      zoomAt((d-ld)*0.004,cx-r.left,cy-r.top);ld=d;
    }
  },{passive:true});
  dom.container.addEventListener('touchend',()=>{t0=null;},{passive:true});
}

function zoomBy(d){zoomAt(d,dom.container.clientWidth/2,dom.container.clientHeight/2);}
function zoomAt(delta,cx,cy){
  const old=State.zoom;
  State.zoom=Math.min(2.5,Math.max(0.1,State.zoom+delta));
  const r=State.zoom/old;
  State.panX=cx-r*(cx-State.panX);State.panY=cy-r*(cy-State.panY);
  applyTransform();
}
function applyTransform(){
  dom.world.style.transform=`translate(${State.panX}px,${State.panY}px) scale(${State.zoom})`;
  dom.zoomLabel.textContent=Math.round(State.zoom*100)+'%';
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────
function initExport(){
  $('btnPrint').addEventListener('click',()=>window.print());
  $('btnFullscreen').addEventListener('click',()=>{
    if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});
    else document.exitFullscreen?.();
  });
  $('btnExportPng').addEventListener('click',()=>alert('Win → Snipping Tool | Mac → Cmd+Shift+4'));
}

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
function initInteractions(){
  dom.panelClose.addEventListener('click',closePanel);
  dom.overlay.addEventListener('click',closePanel);
  $('btnExpandAll').addEventListener('click',expandAll);
  $('btnCollapseAll').addEventListener('click',collapseAll);
  initSearch();initZoomPan();initExport();
}

window.addEventListener('resize',()=>{clearTimeout(window._rt);window._rt=setTimeout(reflow,200);});

// ─── UTILS ───────────────────────────────────────────────────────────────────
function getInitials(name){
  if(!name)return'??';
  const p=name.trim().split(/\s+/).filter(Boolean);
  return p.length===1?p[0].slice(0,2).toUpperCase():(p[0][0]+p[p.length-1][0]).toUpperCase();
}
function escHtml(str){
  if(str==null)return'';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function formatDate(d){
  if(!d)return'—';
  try{const dt=new Date(d);return isNaN(dt.getTime())?String(d):dt.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});}
  catch{return String(d);}
}
function hideLoading(){setTimeout(()=>dom.loading.classList.add('hidden'),900);}

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
function getMockData(){return{
  setores:[
    {ID_SETOR:'SET-001',NOME_SETOR:'PRESIDENTE',                             SETOR_PAI:null,      NIVEL:1,ORDEM:1},
    {ID_SETOR:'SET-002',NOME_SETOR:'SUPERINTENDÊNCIA OPERACIONAL',           SETOR_PAI:'SET-001', NIVEL:2,ORDEM:1},
    {ID_SETOR:'SET-003',NOME_SETOR:'SUPERINTENDÊNCIA DE EXPANSÃO DE REDE',   SETOR_PAI:'SET-001', NIVEL:2,ORDEM:2},
    {ID_SETOR:'SET-004',NOME_SETOR:'SUPERINTENDÊNCIA COMERCIAL CORPORATIVO', SETOR_PAI:'SET-001', NIVEL:2,ORDEM:3},
    {ID_SETOR:'SET-005',NOME_SETOR:'SUPERINTENDÊNCIA MARKETING',             SETOR_PAI:'SET-001', NIVEL:2,ORDEM:4},
    {ID_SETOR:'SET-006',NOME_SETOR:'GESTÃO ASSISTENCIAL',                   SETOR_PAI:'SET-001', NIVEL:2,ORDEM:5},
    {ID_SETOR:'SET-007',NOME_SETOR:'FINANCEIRO/FATURAMENTO/CONTABILIDADE',  SETOR_PAI:'SET-001', NIVEL:2,ORDEM:6},
    {ID_SETOR:'SET-008',NOME_SETOR:'CADASTRO PRESTADOR',     SETOR_PAI:'SET-002',NIVEL:3,ORDEM:1},
    {ID_SETOR:'SET-009',NOME_SETOR:'PÓS VENDAS - PJ',        SETOR_PAI:'SET-002',NIVEL:3,ORDEM:2},
    {ID_SETOR:'SET-010',NOME_SETOR:'CADASTRO CLIENTES',      SETOR_PAI:'SET-002',NIVEL:3,ORDEM:3},
    {ID_SETOR:'SET-011',NOME_SETOR:'SAC CONCIERGE',          SETOR_PAI:'SET-002',NIVEL:3,ORDEM:4},
    {ID_SETOR:'SET-012',NOME_SETOR:'CADASTRO CORRETORES',    SETOR_PAI:'SET-002',NIVEL:3,ORDEM:5},
    {ID_SETOR:'SET-013',NOME_SETOR:'TI',                     SETOR_PAI:'SET-002',NIVEL:3,ORDEM:6},
    {ID_SETOR:'SET-014',NOME_SETOR:'AUDITORIA DE ENTRADA',   SETOR_PAI:'SET-002',NIVEL:3,ORDEM:7},
    {ID_SETOR:'SET-015',NOME_SETOR:'OUVIDORIA',              SETOR_PAI:'SET-002',NIVEL:3,ORDEM:8},
    {ID_SETOR:'SET-016',NOME_SETOR:'GARANTIA DE ATENDIMENTO',SETOR_PAI:'SET-002',NIVEL:3,ORDEM:9},
    {ID_SETOR:'SET-017',NOME_SETOR:'RELACIONAMENTO DE REDE E CONTROLLERS',SETOR_PAI:'SET-002',NIVEL:3,ORDEM:10},
    {ID_SETOR:'SET-018',NOME_SETOR:'IMPLANTAÇÃO PRESTADORES',SETOR_PAI:'SET-002',NIVEL:3,ORDEM:11},
    {ID_SETOR:'SET-019',NOME_SETOR:'ANS',                    SETOR_PAI:'SET-002',NIVEL:3,ORDEM:12},
    {ID_SETOR:'SET-020',NOME_SETOR:'PRODUTOS',               SETOR_PAI:'SET-002',NIVEL:3,ORDEM:13},
    {ID_SETOR:'SET-021',NOME_SETOR:'APOIO PRESTADOR',        SETOR_PAI:'SET-002',NIVEL:3,ORDEM:14},
    {ID_SETOR:'SET-022',NOME_SETOR:'CONTROLE RECLAME AQUI',  SETOR_PAI:'SET-002',NIVEL:3,ORDEM:15},
    {ID_SETOR:'SET-023',NOME_SETOR:'APOIO COMERCIAL PF/PM',  SETOR_PAI:'SET-002',NIVEL:3,ORDEM:16},
    {ID_SETOR:'SET-031',NOME_SETOR:'ASSISTÊNCIA JURÍDICA',   SETOR_PAI:'SET-002',NIVEL:3,ORDEM:17},
    {ID_SETOR:'SET-032',NOME_SETOR:'RECURSOS HUMANOS',       SETOR_PAI:'SET-002',NIVEL:3,ORDEM:18},
    {ID_SETOR:'SET-024',NOME_SETOR:'CREDENCIAMENTO DE PRESTADORES',SETOR_PAI:'SET-003',NIVEL:3,ORDEM:1},
    {ID_SETOR:'SET-025',NOME_SETOR:'RELACIONAMENTO COMERCIAL',    SETOR_PAI:'SET-004',NIVEL:3,ORDEM:1},
    {ID_SETOR:'SET-026',NOME_SETOR:'MARKETING',                   SETOR_PAI:'SET-005',NIVEL:3,ORDEM:1},
    {ID_SETOR:'SET-027',NOME_SETOR:'AUDITORIA MÉDICA',            SETOR_PAI:'SET-006',NIVEL:3,ORDEM:1},
    {ID_SETOR:'SET-028',NOME_SETOR:'CONTAS MÉDICAS',              SETOR_PAI:'SET-006',NIVEL:3,ORDEM:2},
    {ID_SETOR:'SET-029',NOME_SETOR:'LINHAS DE CUIDADO',           SETOR_PAI:'SET-006',NIVEL:3,ORDEM:3},
    {ID_SETOR:'SET-030',NOME_SETOR:'ASSISTÊNCIA MÉDICA',          SETOR_PAI:'SET-006',NIVEL:3,ORDEM:4},
    {ID_SETOR:'SET-033',NOME_SETOR:'CONTAS A PAGAR',              SETOR_PAI:'SET-007',NIVEL:3,ORDEM:1},
    {ID_SETOR:'SET-034',NOME_SETOR:'CONTAS A RECEBER',            SETOR_PAI:'SET-007',NIVEL:3,ORDEM:2},
    {ID_SETOR:'SET-035',NOME_SETOR:'FATURAMENTO',                 SETOR_PAI:'SET-007',NIVEL:3,ORDEM:3},
    {ID_SETOR:'SET-036',NOME_SETOR:'CONTÁBIL',                    SETOR_PAI:'SET-007',NIVEL:3,ORDEM:4},
    {ID_SETOR:'SET-037',NOME_SETOR:'FISCAL',                      SETOR_PAI:'SET-007',NIVEL:3,ORDEM:5},
    {ID_SETOR:'SET-038',NOME_SETOR:'CONTROLADORIA',               SETOR_PAI:'SET-007',NIVEL:3,ORDEM:6},
    {ID_SETOR:'SET-039',NOME_SETOR:'GOVERNANÇA CORPORATIVA',      SETOR_PAI:'SET-007',NIVEL:3,ORDEM:7},
    {ID_SETOR:'SET-040',NOME_SETOR:'AUDITORIA EXTERNA',           SETOR_PAI:'SET-007',NIVEL:3,ORDEM:8},
  ],
  colaboradores:[
    {ID_COLABORADOR:'COL-0200',NOME_COMPLETO:'Patricia Lima',               CARGO:'Presidente',                          SETOR_ID:'SET-001',GESTOR_DIRETO:null,        EMAIL:'presidencia@redeselect.com.br',                TELEFONE:'(11) 99999-0000',RAMAL:'100',CIDADE:'São Paulo',ESTADO:'SP',STATUS:'Ativo',  AREA_ATUACAO:'Nacional',           DATA_ADMISSAO:'2018-01-01',FOTO_URL:null},
    {ID_COLABORADOR:'COL-0100',NOME_COMPLETO:'Roberto Silva',               CARGO:'Superintendente Operacional',         SETOR_ID:'SET-002',GESTOR_DIRETO:null,        EMAIL:'operacional@redeselect.com.br',                TELEFONE:'(11) 98888-0001',RAMAL:'200',CIDADE:'São Paulo',ESTADO:'SP',STATUS:'Ativo',  AREA_ATUACAO:'Nacional',           DATA_ADMISSAO:'2020-03-01',FOTO_URL:null},
    {ID_COLABORADOR:'COL-0002',NOME_COMPLETO:'Edna Marques',                CARGO:'Superintendente de Expansão de Rede', SETOR_ID:'SET-003',GESTOR_DIRETO:null,        EMAIL:'superintendencia.expansao@redeselect.com.br',  TELEFONE:'(98) 98102-1334',RAMAL:null, CIDADE:'Salvador',  ESTADO:'BA',STATUS:'Ativo',  AREA_ATUACAO:'Brasil',             DATA_ADMISSAO:null,        FOTO_URL:null},
    {ID_COLABORADOR:'COL-0010',NOME_COMPLETO:'Reinaldo Costa',              CARGO:'Gerente de Expansão de Rede',         SETOR_ID:'SET-024',GESTOR_DIRETO:'COL-0002', EMAIL:'gerente.expansao@redeselect.com.br',           TELEFONE:'(41) 98000-1111',RAMAL:null, CIDADE:'Curitiba',  ESTADO:'PR',STATUS:'Ativo',  AREA_ATUACAO:'Sul',                DATA_ADMISSAO:'2021-06-01',FOTO_URL:null},
    {ID_COLABORADOR:'COL-0001',NOME_COMPLETO:'Caio Ivankio',                CARGO:'Coordenador de Rede',                 SETOR_ID:'SET-024',GESTOR_DIRETO:'COL-0010', EMAIL:'coordenacao.01@redeselect.com.br',             TELEFONE:'(41) 99933-1072',RAMAL:null, CIDADE:'Curitiba',  ESTADO:'PR',STATUS:'Ativo',  AREA_ATUACAO:'RS; SC; PR; MS e MT',DATA_ADMISSAO:'2026-04-07',FOTO_URL:null},
    {ID_COLABORADOR:'COL-0003',NOME_COMPLETO:'Eduardo Ferreira dos Santos',  CARGO:'Credenciador',                        SETOR_ID:'SET-024',GESTOR_DIRETO:'COL-0001', EMAIL:'centrooeste@redeselect.com.br',                TELEFONE:'(47) 99210-5846',RAMAL:null, CIDADE:'Joinville', ESTADO:'SC',STATUS:'Ativo',  AREA_ATUACAO:'MS e MT',            DATA_ADMISSAO:null,        FOTO_URL:null},
    {ID_COLABORADOR:'COL-0004',NOME_COMPLETO:'Fabiene Rodrigues da Cunha',  CARGO:'Credenciadora',                       SETOR_ID:'SET-024',GESTOR_DIRETO:'COL-0001', EMAIL:'credenciamentosul06@redeselect.com.br',        TELEFONE:'(41) 99550-9475',RAMAL:null, CIDADE:'Curitiba',  ESTADO:'PR',STATUS:'Inativo',AREA_ATUACAO:'PR',                 DATA_ADMISSAO:null,        FOTO_URL:null},
    {ID_COLABORADOR:'COL-0005',NOME_COMPLETO:'Denise Marcarini',            CARGO:'Credenciadora',                       SETOR_ID:'SET-024',GESTOR_DIRETO:'COL-0001', EMAIL:'credenciamentosul03@redeselect.com.br',        TELEFONE:'(51) 99314-2582',RAMAL:null, CIDADE:'Canoas',    ESTADO:'RS',STATUS:'Ativo',  AREA_ATUACAO:'RS',                 DATA_ADMISSAO:null,        FOTO_URL:null},
  ]
};}

document.addEventListener('DOMContentLoaded',init);
