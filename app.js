/* ============================================================
   ORGANOGRAMA SELECT V6 — HIERARQUIA DUAL
   SETOR_PAI (macro) + GESTOR_DIRETO (funcional por setor)
   ============================================================ */
'use strict';

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────
const API_URL = 'https://script.google.com/macros/s/AKfycbxR4Owe_2Y8p1NZfv4SWAKQUskLiePlU3vN-FIbFcO398pMHH4LVYqSk7PQcP9cu4u-/exec';

// ─── DIMENSÕES ────────────────────────────────────────────────────────────────
const CARD_W       = 190;  // largura base (setor e colab)
const CARD_W_ROOT  = 210;  // largura do nó raiz
const CARD_H_SETOR = 150;  // altura card de setor
const CARD_H_COLAB = 110;  // altura card de colaborador (mais compacto)
const GAP_H        = 48;   // espaço horizontal entre irmãos
const GAP_V_SETOR  = 80;   // gap vertical setor→filho
const GAP_V_COLAB  = 60;   // gap vertical colab→colab (cadeia funcional)
const TREE_PAD_V   = 40;   // espaço no topo

// ─── STATUS ───────────────────────────────────────────────────────────────────
const STATUS_COLOR = {
  'Ativo':    '#22C55E',
  'Inativo':  '#9CA3AF',
  'Férias':   '#EAB308',
  'Afastado': '#EF4444',
};

// ─── TIPOS DE NÓ ─────────────────────────────────────────────────────────────
// 'setor' → representa uma unidade organizacional
// 'colab' → representa um colaborador individual na cadeia funcional
const NODE_SETOR = 'setor';
const NODE_COLAB = 'colab';

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
const State = {
  setores:       [],
  colaboradores: [],
  tree:          null,       // raiz da árvore completa (mista setor+colab)
  nodeMap:       {},         // id → nó (tanto setores quanto colabs)
  colabBySetor:  {},         // setorId → [colaboradores]
  colabMap:      {},         // colabId → colaborador
  layout:        {},         // nodeId → { x, y, w, h }
  collapsed:     new Set(),
  activeCard:    null,
  zoom:          1,
  panX:          0,
  panY:          0,
};

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
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
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  applyLogo();
  try {
    const data = await fetchData();
    bootstrap(data);
  } catch (err) {
    console.warn('[Organograma] API indisponível — usando dados de demo.', err.message);
    bootstrap(getMockData());
  }
}

function applyLogo() {
  if (typeof LOGO_SRC === 'undefined') return;
  ['headerLogo', 'loadingLogo'].forEach(id => {
    const el = $(id);
    if (el) el.src = LOGO_SRC;
  });
}

function bootstrap(data) {
  processData(data);
  buildDualTree();
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
  } finally {
    clearTimeout(t);
  }
}

// ─── PROCESS DATA ─────────────────────────────────────────────────────────────
function processData(data) {
  State.setores       = data.setores       || [];
  State.colaboradores = data.colaboradores || [];

  // mapa rápido de colaboradores
  State.colabMap = {};
  State.colaboradores.forEach(c => { State.colabMap[c.ID_COLABORADOR] = c; });

  // agrupamento por setor
  State.colabBySetor = {};
  State.colaboradores.forEach(c => {
    if (!c.SETOR_ID) return;
    if (!State.colabBySetor[c.SETOR_ID]) State.colabBySetor[c.SETOR_ID] = [];
    State.colabBySetor[c.SETOR_ID].push(c);
  });

  // validação de GESTOR_DIRETO
  State.colaboradores.forEach(c => {
    if (c.GESTOR_DIRETO && !State.colabMap[c.GESTOR_DIRETO]) {
      console.warn(
        `[Organograma] Gestor não encontrado para colaborador "${c.NOME_COMPLETO}" (${c.ID_COLABORADOR}): gestor ID="${c.GESTOR_DIRETO}"`
      );
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BUILD DUAL TREE
//  Cria uma árvore mista: nós de setor (macro) + nós de colab (funcional)
//
//  Estrutura resultante por setor:
//    nó-setor
//      └── nó-colab (raiz da cadeia funcional do setor)
//            └── nó-colab (direto reporte)
//                  └── nó-colab ...
//      └── nó-setor-filho  (sub-setores via SETOR_PAI)
// ═══════════════════════════════════════════════════════════════════════════════
function buildDualTree() {
  State.nodeMap = {};

  // ── 1. Criar nós de setor ────────────────────────────────────────────────
  const setorNodes = {};
  State.setores.forEach(s => {
    const node = {
      id:       s.ID_SETOR,
      type:     NODE_SETOR,
      data:     s,
      children: [],   // mistos: colab-raiz + sub-setores
      parent:   null,
      _subW:    0,
      _x: 0, _y: 0,
    };
    setorNodes[s.ID_SETOR] = node;
    State.nodeMap[s.ID_SETOR] = node;
  });

  // ── 2. Montar hierarquia macro de setores via SETOR_PAI ──────────────────
  let root = null;
  State.setores.forEach(s => {
    const node = setorNodes[s.ID_SETOR];
    if (s.SETOR_PAI && setorNodes[s.SETOR_PAI]) {
      node.parent = setorNodes[s.SETOR_PAI];
      setorNodes[s.SETOR_PAI].children.push(node);
    } else {
      root = node;
    }
  });

  // ── 3. Para cada setor, construir sub-árvore funcional via GESTOR_DIRETO ──
  State.setores.forEach(s => {
    const colabs = State.colabBySetor[s.ID_SETOR] || [];
    if (!colabs.length) return;

    const setorNode = setorNodes[s.ID_SETOR];

    // a) Construir mapa colabId → nó-colab
    const colabNodes = {};
    colabs.forEach(c => {
      const cn = {
        id:         c.ID_COLABORADOR,
        type:       NODE_COLAB,
        data:       c,
        children:   [],
        parent:     null,
        setorNode:  setorNode,   // referência ao setor dono
        _subW:      0,
        _x: 0, _y: 0,
      };
      colabNodes[c.ID_COLABORADOR] = cn;
      State.nodeMap[c.ID_COLABORADOR] = cn;
    });

    // b) Montar relações pai-filho dentro do setor via GESTOR_DIRETO
    //    Regra: só vira filho de outro colab se o gestor também pertence a este setor
    const colabRoots = []; // colabs sem gestor NESTE setor (entrada da cadeia)

    colabs.forEach(c => {
      const cn = colabNodes[c.ID_COLABORADOR];

      if (c.GESTOR_DIRETO && colabNodes[c.GESTOR_DIRETO]) {
        // gestor está no mesmo setor → relação funcional interna
        const gestorNode = colabNodes[c.GESTOR_DIRETO];
        cn.parent = gestorNode;
        gestorNode.children.push(cn);
      } else {
        // sem gestor no setor (gestor está acima, em outro setor, ou nulo)
        colabRoots.push(cn);
      }
    });

    // c) Ordenar raízes por cargo (prioridade)
    colabRoots.sort((a, b) => cargoRank(a.data.CARGO) - cargoRank(b.data.CARGO));

    // d) Ordenar filhos recursivamente por cargo
    const sortColabChildren = node => {
      node.children.sort((a, b) => cargoRank(a.data.CARGO) - cargoRank(b.data.CARGO));
      node.children.forEach(sortColabChildren);
    };
    colabRoots.forEach(sortColabChildren);

    // e) Inserir raízes de colabs como filhos do nó-setor
    //    (antes dos sub-setores, para ficarem no topo visual)
    colabRoots.forEach(cn => {
      cn.parent = setorNode;
      setorNode.children.unshift(cn); // insere antes dos sub-setores
    });
  });

  // ── 4. Ordenar filhos de setor: colabs primeiro, depois sub-setores por ORDEM
  const sortSetorChildren = node => {
    // colabs já estão à frente (unshift); ordenar apenas a parte de sub-setores
    const colabPart  = node.children.filter(c => c.type === NODE_COLAB);
    const setorPart  = node.children.filter(c => c.type === NODE_SETOR);
    setorPart.sort((a, b) => (a.data.ORDEM || 99) - (b.data.ORDEM || 99));
    node.children = [...colabPart, ...setorPart];
    node.children.filter(c => c.type === NODE_SETOR).forEach(sortSetorChildren);
  };
  if (root) sortSetorChildren(root);

  State.tree = root;
}

// ─── CARGO RANK (menor = mais importante) ────────────────────────────────────
function cargoRank(cargo) {
  if (!cargo) return 99;
  const c = cargo.toLowerCase();
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
//  LAYOUT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function cardHeight(node) {
  return node.type === NODE_COLAB ? CARD_H_COLAB : CARD_H_SETOR;
}

function cardWidth(node) {
  if (node.type === NODE_SETOR && node.data.NIVEL === 1) return CARD_W_ROOT;
  return CARD_W;
}

function gapV(parentNode) {
  // gap entre pai e filhos
  return parentNode.type === NODE_COLAB ? GAP_V_COLAB : GAP_V_SETOR;
}

// Passo 1: mede a largura de cada subárvore recursivamente
function measureSubtree(node) {
  const cw = cardWidth(node);

  if (State.collapsed.has(node.id) || node.children.length === 0) {
    node._subW = cw;
    return cw;
  }

  let total = 0;
  node.children.forEach((child, i) => {
    total += measureSubtree(child);
    if (i < node.children.length - 1) total += GAP_H;
  });

  node._subW = Math.max(cw, total);
  return node._subW;
}

// Passo 2: posiciona cada nó
function placeNodes(node, left, y) {
  const cw = cardWidth(node);
  const ch = cardHeight(node);
  const cx = left + (node._subW - cw) / 2;

  node._x = cx;
  node._y = y;
  State.layout[node.id] = { x: cx, y, w: cw, h: ch };

  if (State.collapsed.has(node.id) || node.children.length === 0) return;

  const gap = gapV(node);
  let childLeft = left;
  node.children.forEach(child => {
    placeNodes(child, childLeft, y + ch + gap);
    childLeft += child._subW + GAP_H;
  });
}

// Passo 3: bounding box
function computeBounds() {
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = n => {
    if (!n) return;
    const pos = State.layout[n.id];
    if (pos) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x + pos.w);
      maxY = Math.max(maxY, pos.y + pos.h);
    }
    if (!State.collapsed.has(n.id)) n.children.forEach(visit);
  };
  visit(State.tree);
  return { minX, maxX, maxY };
}

function reflow() {
  if (!State.tree) return;
  State.layout = {};

  measureSubtree(State.tree);
  placeNodes(State.tree, 0, TREE_PAD_V);

  const { minX, maxX, maxY } = computeBounds();

  // normaliza se necessário
  if (minX < 0) {
    const shift = -minX + 40;
    const visit = n => {
      const pos = State.layout[n.id];
      if (pos) { pos.x += shift; n._x += shift; }
      n.children.forEach(visit);
    };
    visit(State.tree);
  }

  const treeW = (maxX - Math.min(0, minX)) + 80;
  const treeH = maxY + 100;

  dom.world.style.width  = treeW + 'px';
  dom.world.style.height = treeH + 'px';

  const vpW = dom.container.clientWidth;
  const vpH = dom.container.clientHeight;
  State.zoom = Math.min(1, (vpW - 40) / treeW, (vpH - 40) / treeH);
  State.panX = Math.max(0, (vpW - treeW * State.zoom) / 2);
  State.panY = 20;

  applyTransform();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════════════════════════

function renderAll() {
  renderCards();
  renderConnections();
}

function renderCards() {
  const frag = document.createDocumentFragment();
  let delay = 0;

  const traverse = node => {
    if (!node) return;
    const pos = State.layout[node.id];
    if (!pos) return;

    const el = node.type === NODE_COLAB
      ? buildColabCard(node, pos)
      : buildSetorCard(node, pos);

    el.style.animationDelay = Math.min(delay * 30, 600) + 'ms';
    frag.appendChild(el);
    delay++;

    if (!State.collapsed.has(node.id)) {
      node.children.forEach(traverse);
    }
  };

  traverse(State.tree);
  dom.cards.innerHTML = '';
  dom.cards.appendChild(frag);
}

// ─── CARD DE SETOR ────────────────────────────────────────────────────────────
function buildSetorCard(node, pos) {
  const setor   = node.data;
  const level   = setor.NIVEL || 1;
  const hasKids = node.children.length > 0;
  const isCollapsed = State.collapsed.has(node.id);

  // Para exibição no topo do card: nome do setor + total de colabs no setor
  const totalColabs = countColabsInBranch(node);

  const div = document.createElement('div');
  div.className = `sector-card setor-node level-${level}`;
  div.dataset.nodeId   = node.id;
  div.dataset.nodeType = NODE_SETOR;
  div.style.left   = pos.x + 'px';
  div.style.top    = pos.y + 'px';
  div.style.width  = pos.w + 'px';
  div.style.height = pos.h + 'px';

  div.innerHTML = `
    <div class="card-top-bar"></div>
    <div class="card-body setor-body">
      <div class="card-sector-name">${escHtml(setor.NOME_SETOR)}</div>
      <div class="setor-colabs-count">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        ${totalColabs} colaborador${totalColabs !== 1 ? 'es' : ''}
      </div>
    </div>
    ${hasKids ? `
      <div class="card-toggle${isCollapsed ? ' collapsed' : ''}" data-node-id="${node.id}" title="${isCollapsed ? 'Expandir' : 'Recolher'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
    ` : ''}
  `;

  div.addEventListener('click', e => {
    if (e.target.closest('.card-toggle')) return;
    openSetorPanel(node);
    setActiveCard(node.id);
  });

  const toggle = div.querySelector('.card-toggle');
  if (toggle) {
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      toggleCollapse(node.id);
    });
  }

  return div;
}

// Conta colaboradores em todos os nós-colab descendentes de um setor
function countColabsInBranch(setorNode) {
  let count = 0;
  const visit = n => {
    if (n.type === NODE_COLAB) count++;
    n.children.forEach(visit);
  };
  setorNode.children.forEach(visit);
  return count;
}

// ─── CARD DE COLABORADOR ──────────────────────────────────────────────────────
function buildColabCard(node, pos) {
  const colab    = node.data;
  const hasKids  = node.children.length > 0;
  const isCollapsed = State.collapsed.has(node.id);
  const statusColor = STATUS_COLOR[colab.STATUS] || '#9CA3AF';
  const initials    = getInitials(colab.NOME_COMPLETO);

  const avatarInner = colab.FOTO_URL
    ? `<img src="${escHtml(colab.FOTO_URL)}" alt="${escHtml(colab.NOME_COMPLETO)}" loading="lazy" />`
    : `<span>${initials}</span>`;

  const div = document.createElement('div');
  div.className    = 'sector-card colab-node';
  div.dataset.nodeId   = node.id;
  div.dataset.nodeType = NODE_COLAB;
  div.style.left   = pos.x + 'px';
  div.style.top    = pos.y + 'px';
  div.style.width  = pos.w + 'px';
  div.style.height = pos.h + 'px';

  div.innerHTML = `
    <div class="card-top-bar colab-bar"></div>
    <div class="card-body colab-body">
      <div class="card-avatar colab-avatar-sm">${avatarInner}</div>
      <div class="colab-info-block">
        <div class="card-manager-name">${escHtml(colab.NOME_COMPLETO)}</div>
        <div class="card-manager-role">${escHtml(colab.CARGO || '')}</div>
        <div class="colab-status-badge">
          <span class="status-dot-inline" style="background:${statusColor}"></span>
          <span class="status-text">${escHtml(colab.STATUS || '')}</span>
        </div>
      </div>
    </div>
    ${hasKids ? `
      <div class="card-toggle${isCollapsed ? ' collapsed' : ''}" data-node-id="${node.id}" title="${isCollapsed ? 'Expandir' : 'Recolher'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
    ` : ''}
  `;

  div.addEventListener('click', e => {
    if (e.target.closest('.card-toggle')) return;
    renderCollabPanel(colab);
    setActiveCard(node.id);
  });

  const toggle = div.querySelector('.card-toggle');
  if (toggle) {
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      toggleCollapse(node.id);
    });
  }

  return div;
}

// ─── CONNECTIONS ──────────────────────────────────────────────────────────────
function renderConnections() {
  const frag = document.createDocumentFragment();

  const traverse = node => {
    if (!node || State.collapsed.has(node.id)) return;
    if (!node.children.length) return;

    const pPos  = State.layout[node.id];
    if (!pPos) return;

    const pBotX = pPos.x + pPos.w / 2;
    const pBotY = pPos.y + pPos.h;
    const gap   = gapV(node);
    const midY  = pBotY + gap * 0.42;

    frag.appendChild(makeLine(pBotX, pBotY, pBotX, midY));

    const visKids = node.children.filter(k => State.layout[k.id]);

    if (visKids.length > 1) {
      const fx = State.layout[visKids[0].id].x + State.layout[visKids[0].id].w / 2;
      const lx = State.layout[visKids[visKids.length-1].id].x + State.layout[visKids[visKids.length-1].id].w / 2;
      frag.appendChild(makeLine(fx, midY, lx, midY));
    }

    visKids.forEach(child => {
      const cPos  = State.layout[child.id];
      const cTopX = cPos.x + cPos.w / 2;
      frag.appendChild(makeLine(cTopX, midY, cTopX, cPos.y));
      traverse(child);
    });
  };

  traverse(State.tree);
  dom.svg.innerHTML = '';
  dom.svg.appendChild(frag);
}

function makeLine(x1, y1, x2, y2) {
  const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l.setAttribute('x1', x1); l.setAttribute('y1', y1);
  l.setAttribute('x2', x2); l.setAttribute('y2', y2);
  l.setAttribute('class', 'connector-line');
  return l;
}

// ─── TOGGLE COLLAPSE ──────────────────────────────────────────────────────────
function toggleCollapse(nodeId) {
  if (State.collapsed.has(nodeId)) State.collapsed.delete(nodeId);
  else State.collapsed.add(nodeId);
  reflow();
  renderAll();
}

function expandAll() {
  State.collapsed.clear();
  reflow();
  renderAll();
}

function collapseAll() {
  State.collapsed.clear();
  const traverse = node => {
    if (!node) return;
    if (node.children.length > 0 && node.parent !== null) {
      State.collapsed.add(node.id);
    }
    node.children.forEach(traverse);
  };
  traverse(State.tree);
  reflow();
  renderAll();
}

// ─── ACTIVE CARD ─────────────────────────────────────────────────────────────
function setActiveCard(nodeId) {
  document.querySelectorAll('.sector-card.active').forEach(el => el.classList.remove('active'));
  if (nodeId) {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (el) el.classList.add('active');
  }
  State.activeCard = nodeId;
}

// ─── PANEL — SETOR ────────────────────────────────────────────────────────────
function openSetorPanel(node) {
  const setor    = node.data;
  const colabs   = getAllColabsInBranch(node);

  dom.panelContent.innerHTML = `
    <div class="panel-hero">
      <div class="panel-avatar">
        <span>${setor.NOME_SETOR.slice(0,2).toUpperCase()}</span>
      </div>
      <div class="panel-hero-info">
        <div class="panel-name">${escHtml(setor.NOME_SETOR)}</div>
        <div class="panel-role">Setor · ${colabs.length} colaborador${colabs.length !== 1 ? 'es' : ''}</div>
      </div>
    </div>
  `;

  if (colabs.length > 0) {
    dom.panelColabs.style.display = 'block';
    dom.colabsList.innerHTML = colabs.map(buildColabItem).join('');
    dom.colabsList.querySelectorAll('.colaborador-item').forEach(item => {
      item.addEventListener('click', () => {
        const c = State.colabMap[item.dataset.colabId];
        if (c) renderCollabPanel(c);
      });
    });
  } else {
    dom.panelColabs.style.display = 'none';
  }

  openPanel();
}

function getAllColabsInBranch(setorNode) {
  const list = [];
  const visit = n => {
    if (n.type === NODE_COLAB) list.push(n.data);
    n.children.forEach(visit);
  };
  setorNode.children.forEach(visit);
  return list;
}

// ─── PANEL — COLABORADOR ─────────────────────────────────────────────────────
function renderCollabPanel(colab) {
  const statusColor  = STATUS_COLOR[colab.STATUS] || '#9CA3AF';
  const initials     = getInitials(colab.NOME_COMPLETO);
  const avatarInner  = colab.FOTO_URL
    ? `<img src="${escHtml(colab.FOTO_URL)}" alt="${escHtml(colab.NOME_COMPLETO)}" />`
    : `<span>${initials}</span>`;

  const gestor = colab.GESTOR_DIRETO ? State.colabMap[colab.GESTOR_DIRETO] : null;
  const setor  = State.nodeMap[colab.SETOR_ID]?.data;

  // Liderados diretos
  const liderados = State.colaboradores.filter(c => c.GESTOR_DIRETO === colab.ID_COLABORADOR);

  dom.panelContent.innerHTML = `
    <div class="panel-hero">
      <div class="panel-avatar">${avatarInner}</div>
      <div class="panel-hero-info">
        <div class="panel-name">${escHtml(colab.NOME_COMPLETO)}</div>
        <div class="panel-role">${escHtml(colab.CARGO || '')}</div>
        <div class="panel-status">
          <span class="status-dot" style="background:${statusColor}"></span>
          ${escHtml(colab.STATUS || 'Ativo')}
        </div>
      </div>
    </div>
    <div class="panel-fields">
      ${setor   ? fieldRow('building',   'Setor',         escHtml(setor.NOME_SETOR)) : ''}
      ${gestor  ? `<div class="panel-field">
          ${fieldIcon('user-check')}
          <div class="panel-field-content">
            <div class="panel-field-label">Gestor Direto</div>
            <div class="panel-field-value clickable" data-colab-id="${gestor.ID_COLABORADOR}">${escHtml(gestor.NOME_COMPLETO)}</div>
          </div>
        </div>` : ''}
      ${liderados.length ? fieldRow('users', 'Liderados diretos', liderados.map(l => escHtml(l.NOME_COMPLETO)).join(', ')) : ''}
      ${colab.EMAIL       ? fieldRow('mail',     'E-mail',          `<a href="mailto:${escHtml(colab.EMAIL)}">${escHtml(colab.EMAIL)}</a>`) : ''}
      ${colab.TELEFONE    ? fieldRow('phone',    'Telefone',        escHtml(colab.TELEFONE)) : ''}
      ${colab.RAMAL       ? fieldRow('hash',     'Ramal',           escHtml(colab.RAMAL))    : ''}
      ${(colab.CIDADE && colab.ESTADO) ? fieldRow('map-pin', 'Localização', `${escHtml(colab.CIDADE)} — ${escHtml(colab.ESTADO)}`) : ''}
      ${colab.AREA_ATUACAO  ? fieldRow('globe',    'Área de Atuação', escHtml(colab.AREA_ATUACAO))    : ''}
      ${colab.DATA_ADMISSAO ? fieldRow('calendar', 'Admissão',        formatDate(colab.DATA_ADMISSAO)) : ''}
    </div>
  `;

  const gestorEl = dom.panelContent.querySelector('[data-colab-id]');
  if (gestorEl) {
    gestorEl.addEventListener('click', () => {
      const g = State.colabMap[gestorEl.dataset.colabId];
      if (g) renderCollabPanel(g);
    });
  }

  // limpa lista de equipe no painel ao abrir colab diretamente
  dom.panelColabs.style.display = 'none';
  openPanel();
}

// ─── PANEL HELPERS ───────────────────────────────────────────────────────────
function fieldRow(iconName, label, value) {
  return `
    <div class="panel-field">
      ${fieldIcon(iconName)}
      <div class="panel-field-content">
        <div class="panel-field-label">${label}</div>
        <div class="panel-field-value">${value}</div>
      </div>
    </div>
  `;
}

function fieldIcon(name) {
  const paths = {
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
  const p = paths[name] || paths['building'];
  return `<div class="panel-field-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${p}</svg></div>`;
}

function buildColabItem(c) {
  const sc       = STATUS_COLOR[c.STATUS] || '#9CA3AF';
  const initials = getInitials(c.NOME_COMPLETO);
  const av       = c.FOTO_URL
    ? `<img src="${escHtml(c.FOTO_URL)}" alt="${escHtml(c.NOME_COMPLETO)}" loading="lazy" />`
    : `<span>${initials}</span>`;
  return `
    <div class="colaborador-item" data-colab-id="${c.ID_COLABORADOR}">
      <div class="colab-avatar">${av}</div>
      <div class="colab-info">
        <div class="colab-name">${escHtml(c.NOME_COMPLETO)}</div>
        <div class="colab-role">${escHtml(c.CARGO || '')}</div>
      </div>
      <div class="colab-status" style="background:${sc}"></div>
    </div>
  `;
}

// ─── PANEL OPEN/CLOSE ────────────────────────────────────────────────────────
function openPanel() {
  dom.panel.classList.add('open');
  dom.overlay.classList.remove('hidden');
}

function closePanel() {
  dom.panel.classList.remove('open');
  dom.overlay.classList.add('hidden');
  setActiveCard(null);
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────
function initSearch() {
  dom.searchInput.addEventListener('input', handleSearch);
  document.addEventListener('click', e => {
    if (!dom.searchDrop.contains(e.target) && e.target !== dom.searchInput) {
      dom.searchDrop.classList.add('hidden');
    }
  });
  dom.searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { dom.searchDrop.classList.add('hidden'); dom.searchInput.blur(); }
  });
}

function handleSearch() {
  const q = dom.searchInput.value.trim().toLowerCase();
  if (q.length < 2) { dom.searchDrop.classList.add('hidden'); return; }

  const colabR = State.colaboradores.filter(c =>
    [c.NOME_COMPLETO, c.CARGO, c.EMAIL, c.CIDADE, c.ESTADO, c.AREA_ATUACAO]
      .some(v => v && v.toLowerCase().includes(q))
  ).slice(0, 7);

  const setorR = State.setores.filter(s =>
    s.NOME_SETOR && s.NOME_SETOR.toLowerCase().includes(q)
  ).slice(0, 3);

  if (!colabR.length && !setorR.length) {
    dom.searchDrop.innerHTML = `<div style="padding:12px 14px;font-size:12.5px;color:var(--text-muted)">Nenhum resultado</div>`;
    dom.searchDrop.classList.remove('hidden');
    return;
  }

  let html = '';
  colabR.forEach(c => {
    const sc = STATUS_COLOR[c.STATUS] || '#9CA3AF';
    const setorName = c.SETOR_ID && State.nodeMap[c.SETOR_ID] ? State.nodeMap[c.SETOR_ID].data.NOME_SETOR : '';
    html += `
      <div class="search-item" data-colab-id="${c.ID_COLABORADOR}" data-setor-id="${c.SETOR_ID||''}">
        <div class="search-item-avatar">${c.FOTO_URL ? `<img src="${escHtml(c.FOTO_URL)}" />` : getInitials(c.NOME_COMPLETO)}</div>
        <div class="search-item-info">
          <div class="search-item-name">${escHtml(c.NOME_COMPLETO)}</div>
          <div class="search-item-meta">${escHtml(c.CARGO||'')}${setorName ? ' · '+escHtml(setorName) : ''}</div>
        </div>
        <div class="search-item-status" style="background:${sc}"></div>
      </div>`;
  });
  setorR.forEach(s => {
    const total = countSetorColabs(s.ID_SETOR);
    html += `
      <div class="search-item" data-setor-id="${s.ID_SETOR}">
        <div class="search-item-avatar" style="font-size:10px">${s.NOME_SETOR.slice(0,2).toUpperCase()}</div>
        <div class="search-item-info">
          <div class="search-item-name">${escHtml(s.NOME_SETOR)}</div>
          <div class="search-item-meta">Setor · ${total} colaborador${total!==1?'es':''}</div>
        </div>
      </div>`;
  });

  dom.searchDrop.innerHTML = html;
  dom.searchDrop.classList.remove('hidden');

  dom.searchDrop.querySelectorAll('.search-item').forEach(item => {
    item.addEventListener('click', () => {
      dom.searchInput.value = '';
      dom.searchDrop.classList.add('hidden');
      const colabId = item.dataset.colabId;
      const setorId = item.dataset.setorId;
      if (colabId) {
        const c = State.colabMap[colabId];
        if (c) renderCollabPanel(c);
        if (colabId) ensureVisible(colabId);
        if (colabId) centerOn(colabId);
      } else if (setorId) {
        const n = State.nodeMap[setorId];
        if (n) openSetorPanel(n);
        ensureVisible(setorId);
        centerOn(setorId);
      }
    });
  });
}

function countSetorColabs(setorId) {
  const n = State.nodeMap[setorId];
  if (!n) return 0;
  return getAllColabsInBranch(n).length;
}

function ensureVisible(nodeId) {
  const node = State.nodeMap[nodeId];
  if (!node) return;
  let changed = false;
  let cur = node.parent;
  while (cur) {
    if (State.collapsed.has(cur.id)) { State.collapsed.delete(cur.id); changed = true; }
    cur = cur.parent;
  }
  if (changed) { reflow(); renderAll(); }
}

function centerOn(nodeId) {
  const pos = State.layout[nodeId];
  if (!pos) return;
  const vpW = dom.container.clientWidth;
  const vpH = dom.container.clientHeight;
  State.panX = vpW / 2 - (pos.x + pos.w / 2) * State.zoom;
  State.panY = vpH / 2 - (pos.y + pos.h / 2) * State.zoom;
  applyTransform();
  document.querySelectorAll('.sector-card.highlighted').forEach(el => el.classList.remove('highlighted'));
  const el = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (el) { el.classList.add('highlighted'); setTimeout(() => el.classList.remove('highlighted'), 3000); }
}

// ─── ZOOM & PAN ──────────────────────────────────────────────────────────────
function initZoomPan() {
  $('btnZoomIn').addEventListener('click',    () => zoomBy(0.12));
  $('btnZoomOut').addEventListener('click',   () => zoomBy(-0.12));
  $('btnZoomReset').addEventListener('click', () => reflow());

  dom.container.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.07 : -0.07;
    const rect  = dom.container.getBoundingClientRect();
    zoomAt(delta, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  let dragging = false, sx = 0, sy = 0, spx = 0, spy = 0;
  dom.container.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.sector-card') || e.target.closest('.card-toggle')) return;
    dragging = true; sx = e.clientX; sy = e.clientY; spx = State.panX; spy = State.panY;
    dom.container.classList.add('grabbing');
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    State.panX = spx + (e.clientX - sx);
    State.panY = spy + (e.clientY - sy);
    applyTransform();
  });
  document.addEventListener('mouseup', () => { dragging = false; dom.container.classList.remove('grabbing'); });

  let t0 = null, tpx = 0, tpy = 0, ld = 0;
  dom.container.addEventListener('touchstart', e => {
    if (e.touches.length === 1) { t0 = e.touches[0]; tpx = State.panX; tpy = State.panY; }
    else if (e.touches.length === 2) { ld = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY); }
  }, {passive:true});
  dom.container.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && t0) {
      State.panX = tpx + (e.touches[0].clientX - t0.clientX);
      State.panY = tpy + (e.touches[0].clientY - t0.clientY);
      applyTransform();
    } else if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
      const cx = (e.touches[0].clientX+e.touches[1].clientX)/2;
      const cy = (e.touches[0].clientY+e.touches[1].clientY)/2;
      const rect = dom.container.getBoundingClientRect();
      zoomAt((d-ld)*0.004, cx-rect.left, cy-rect.top);
      ld = d;
    }
  }, {passive:true});
  dom.container.addEventListener('touchend', () => { t0 = null; }, {passive:true});
}

function zoomBy(delta) {
  zoomAt(delta, dom.container.clientWidth/2, dom.container.clientHeight/2);
}

function zoomAt(delta, cx, cy) {
  const old = State.zoom;
  State.zoom = Math.min(2.5, Math.max(0.1, State.zoom + delta));
  const r = State.zoom / old;
  State.panX = cx - r*(cx - State.panX);
  State.panY = cy - r*(cy - State.panY);
  applyTransform();
}

function applyTransform() {
  dom.world.style.transform = `translate(${State.panX}px,${State.panY}px) scale(${State.zoom})`;
  dom.zoomLabel.textContent  = Math.round(State.zoom * 100) + '%';
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────
function initExport() {
  $('btnPrint').addEventListener('click', () => window.print());
  $('btnFullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(()=>{});
    else document.exitFullscreen?.();
  });
  $('btnExportPng').addEventListener('click', () => {
    alert('Para exportar em PNG: use a ferramenta de captura do sistema (Win: Snipping Tool | Mac: Cmd+Shift+4). Para exportação programática, adicione html2canvas ao projeto.');
  });
}

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
function initInteractions() {
  dom.panelClose.addEventListener('click', closePanel);
  dom.overlay.addEventListener('click', closePanel);
  $('btnExpandAll').addEventListener('click', expandAll);
  $('btnCollapseAll').addEventListener('click', collapseAll);
  initSearch();
  initZoomPan();
  initExport();
}

// ─── RESIZE ──────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  clearTimeout(window._rt);
  window._rt = setTimeout(reflow, 200);
});

// ─── UTILS ───────────────────────────────────────────────────────────────────
function getInitials(name) {
  if (!name) return '??';
  const p = name.trim().split(/\s+/).filter(Boolean);
  return p.length === 1 ? p[0].slice(0,2).toUpperCase() : (p[0][0]+p[p.length-1][0]).toUpperCase();
}

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function formatDate(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
  } catch { return String(d); }
}

function hideLoading() {
  setTimeout(() => dom.loading.classList.add('hidden'), 900);
}

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
function getMockData() {
  return {
    setores: [
      { ID_SETOR:'SET-001', NOME_SETOR:'PRESIDENTE',                             SETOR_PAI:null,      NIVEL:1, ORDEM:1  },
      { ID_SETOR:'SET-002', NOME_SETOR:'SUPERINTENDÊNCIA OPERACIONAL',           SETOR_PAI:'SET-001', NIVEL:2, ORDEM:1  },
      { ID_SETOR:'SET-003', NOME_SETOR:'SUPERINTENDÊNCIA DE EXPANSÃO DE REDE',   SETOR_PAI:'SET-001', NIVEL:2, ORDEM:2  },
      { ID_SETOR:'SET-004', NOME_SETOR:'SUPERINTENDÊNCIA COMERCIAL CORPORATIVO', SETOR_PAI:'SET-001', NIVEL:2, ORDEM:3  },
      { ID_SETOR:'SET-005', NOME_SETOR:'SUPERINTENDÊNCIA MARKETING',             SETOR_PAI:'SET-001', NIVEL:2, ORDEM:4  },
      { ID_SETOR:'SET-006', NOME_SETOR:'GESTÃO ASSISTENCIAL',                   SETOR_PAI:'SET-001', NIVEL:2, ORDEM:5  },
      { ID_SETOR:'SET-007', NOME_SETOR:'FINANCEIRO/FATURAMENTO/CONTABILIDADE',  SETOR_PAI:'SET-001', NIVEL:2, ORDEM:6  },
      { ID_SETOR:'SET-008', NOME_SETOR:'CADASTRO PRESTADOR',                    SETOR_PAI:'SET-002', NIVEL:3, ORDEM:1  },
      { ID_SETOR:'SET-009', NOME_SETOR:'PÓS VENDAS - PJ',                       SETOR_PAI:'SET-002', NIVEL:3, ORDEM:2  },
      { ID_SETOR:'SET-010', NOME_SETOR:'CADASTRO CLIENTES',                     SETOR_PAI:'SET-002', NIVEL:3, ORDEM:3  },
      { ID_SETOR:'SET-011', NOME_SETOR:'SAC CONCIERGE',                         SETOR_PAI:'SET-002', NIVEL:3, ORDEM:4  },
      { ID_SETOR:'SET-012', NOME_SETOR:'CADASTRO CORRETORES',                   SETOR_PAI:'SET-002', NIVEL:3, ORDEM:5  },
      { ID_SETOR:'SET-013', NOME_SETOR:'TI',                                    SETOR_PAI:'SET-002', NIVEL:3, ORDEM:6  },
      { ID_SETOR:'SET-014', NOME_SETOR:'AUDITORIA DE ENTRADA',                  SETOR_PAI:'SET-002', NIVEL:3, ORDEM:7  },
      { ID_SETOR:'SET-015', NOME_SETOR:'OUVIDORIA',                             SETOR_PAI:'SET-002', NIVEL:3, ORDEM:8  },
      { ID_SETOR:'SET-016', NOME_SETOR:'GARANTIA DE ATENDIMENTO',               SETOR_PAI:'SET-002', NIVEL:3, ORDEM:9  },
      { ID_SETOR:'SET-017', NOME_SETOR:'RELACIONAMENTO DE REDE E CONTROLLERS',  SETOR_PAI:'SET-002', NIVEL:3, ORDEM:10 },
      { ID_SETOR:'SET-018', NOME_SETOR:'IMPLANTAÇÃO PRESTADORES',               SETOR_PAI:'SET-002', NIVEL:3, ORDEM:11 },
      { ID_SETOR:'SET-019', NOME_SETOR:'ANS',                                   SETOR_PAI:'SET-002', NIVEL:3, ORDEM:12 },
      { ID_SETOR:'SET-020', NOME_SETOR:'PRODUTOS',                              SETOR_PAI:'SET-002', NIVEL:3, ORDEM:13 },
      { ID_SETOR:'SET-021', NOME_SETOR:'APOIO PRESTADOR',                       SETOR_PAI:'SET-002', NIVEL:3, ORDEM:14 },
      { ID_SETOR:'SET-022', NOME_SETOR:'CONTROLE RECLAME AQUI, NIP, LIMINAR',   SETOR_PAI:'SET-002', NIVEL:3, ORDEM:15 },
      { ID_SETOR:'SET-023', NOME_SETOR:'APOIO COMERCIAL PF/PM/CORPORATIVO',     SETOR_PAI:'SET-002', NIVEL:3, ORDEM:16 },
      { ID_SETOR:'SET-031', NOME_SETOR:'ASSISTÊNCIA JURÍDICA',                 SETOR_PAI:'SET-002', NIVEL:3, ORDEM:17 },
      { ID_SETOR:'SET-032', NOME_SETOR:'RECURSOS HUMANOS',                     SETOR_PAI:'SET-002', NIVEL:3, ORDEM:18 },
      { ID_SETOR:'SET-024', NOME_SETOR:'CREDENCIAMENTO DE PRESTADORES',         SETOR_PAI:'SET-003', NIVEL:3, ORDEM:1  },
      { ID_SETOR:'SET-025', NOME_SETOR:'RELACIONAMENTO COMERCIAL',              SETOR_PAI:'SET-004', NIVEL:3, ORDEM:1  },
      { ID_SETOR:'SET-026', NOME_SETOR:'MARKETING',                             SETOR_PAI:'SET-005', NIVEL:3, ORDEM:1  },
      { ID_SETOR:'SET-027', NOME_SETOR:'AUDITORIA MÉDICA',                     SETOR_PAI:'SET-006', NIVEL:3, ORDEM:1  },
      { ID_SETOR:'SET-028', NOME_SETOR:'CONTAS MÉDICAS',                       SETOR_PAI:'SET-006', NIVEL:3, ORDEM:2  },
      { ID_SETOR:'SET-029', NOME_SETOR:'LINHAS DE CUIDADO',                    SETOR_PAI:'SET-006', NIVEL:3, ORDEM:3  },
      { ID_SETOR:'SET-030', NOME_SETOR:'ASSISTÊNCIA MÉDICA',                   SETOR_PAI:'SET-006', NIVEL:3, ORDEM:4  },
      { ID_SETOR:'SET-033', NOME_SETOR:'CONTAS A PAGAR',                       SETOR_PAI:'SET-007', NIVEL:3, ORDEM:1  },
      { ID_SETOR:'SET-034', NOME_SETOR:'CONTAS A RECEBER',                     SETOR_PAI:'SET-007', NIVEL:3, ORDEM:2  },
      { ID_SETOR:'SET-035', NOME_SETOR:'FATURAMENTO',                          SETOR_PAI:'SET-007', NIVEL:3, ORDEM:3  },
      { ID_SETOR:'SET-036', NOME_SETOR:'CONTÁBIL',                             SETOR_PAI:'SET-007', NIVEL:3, ORDEM:4  },
      { ID_SETOR:'SET-037', NOME_SETOR:'FISCAL',                               SETOR_PAI:'SET-007', NIVEL:3, ORDEM:5  },
      { ID_SETOR:'SET-038', NOME_SETOR:'CONTROLADORIA',                        SETOR_PAI:'SET-007', NIVEL:3, ORDEM:6  },
      { ID_SETOR:'SET-039', NOME_SETOR:'GOVERNANÇA CORPORATIVA',               SETOR_PAI:'SET-007', NIVEL:3, ORDEM:7  },
      { ID_SETOR:'SET-040', NOME_SETOR:'AUDITORIA EXTERNA',                    SETOR_PAI:'SET-007', NIVEL:3, ORDEM:8  },
    ],
    colaboradores: [
      // Presidente
      { ID_COLABORADOR:'COL-0200', NOME_COMPLETO:'Patricia Lima',               CARGO:'Presidente',                          SETOR_ID:'SET-001', GESTOR_DIRETO:null,        EMAIL:'presidencia@redeselect.com.br',                TELEFONE:'(11) 99999-0000', RAMAL:'100', CIDADE:'São Paulo', ESTADO:'SP', STATUS:'Ativo',   AREA_ATUACAO:'Nacional',            DATA_ADMISSAO:'2018-01-01', FOTO_URL:null },
      // Sup. Operacional
      { ID_COLABORADOR:'COL-0100', NOME_COMPLETO:'Roberto Silva',               CARGO:'Superintendente Operacional',         SETOR_ID:'SET-002', GESTOR_DIRETO:null,        EMAIL:'operacional@redeselect.com.br',                TELEFONE:'(11) 98888-0001', RAMAL:'200', CIDADE:'São Paulo', ESTADO:'SP', STATUS:'Ativo',   AREA_ATUACAO:'Nacional',            DATA_ADMISSAO:'2020-03-01', FOTO_URL:null },
      // Sup. Expansão de Rede → cadeia Edna → Reinaldo → Caio → credenciadores
      { ID_COLABORADOR:'COL-0002', NOME_COMPLETO:'Edna Marques',               CARGO:'Superintendente de Expansão de Rede', SETOR_ID:'SET-003', GESTOR_DIRETO:null,        EMAIL:'superintendencia.expansao@redeselect.com.br', TELEFONE:'(98) 98102-1334', RAMAL:null,  CIDADE:'Salvador',  ESTADO:'BA', STATUS:'Ativo',   AREA_ATUACAO:'Brasil',              DATA_ADMISSAO:null,         FOTO_URL:null },
      { ID_COLABORADOR:'COL-0010', NOME_COMPLETO:'Reinaldo Costa',             CARGO:'Gerente de Expansão de Rede',         SETOR_ID:'SET-024', GESTOR_DIRETO:'COL-0002', EMAIL:'gerente.expansao@redeselect.com.br',           TELEFONE:'(41) 98000-1111', RAMAL:null,  CIDADE:'Curitiba',  ESTADO:'PR', STATUS:'Ativo',   AREA_ATUACAO:'Sul',                 DATA_ADMISSAO:'2021-06-01', FOTO_URL:null },
      { ID_COLABORADOR:'COL-0001', NOME_COMPLETO:'Caio Ivankio',               CARGO:'Coordenador de Rede',                 SETOR_ID:'SET-024', GESTOR_DIRETO:'COL-0010', EMAIL:'coordenacao.01@redeselect.com.br',             TELEFONE:'(41) 99933-1072', RAMAL:null,  CIDADE:'Curitiba',  ESTADO:'PR', STATUS:'Ativo',   AREA_ATUACAO:'RS; SC; PR; MS e MT', DATA_ADMISSAO:'2026-04-07', FOTO_URL:null },
      { ID_COLABORADOR:'COL-0003', NOME_COMPLETO:'Eduardo Ferreira dos Santos', CARGO:'Credenciador',                        SETOR_ID:'SET-024', GESTOR_DIRETO:'COL-0001', EMAIL:'centrooeste@redeselect.com.br',                TELEFONE:'(47) 99210-5846', RAMAL:null,  CIDADE:'Joinville', ESTADO:'SC', STATUS:'Ativo',   AREA_ATUACAO:'MS e MT',             DATA_ADMISSAO:null,         FOTO_URL:null },
      { ID_COLABORADOR:'COL-0004', NOME_COMPLETO:'Fabiene Rodrigues da Cunha', CARGO:'Credenciadora',                       SETOR_ID:'SET-024', GESTOR_DIRETO:'COL-0001', EMAIL:'credenciamentosul06@redeselect.com.br',        TELEFONE:'(41) 99550-9475', RAMAL:null,  CIDADE:'Curitiba',  ESTADO:'PR', STATUS:'Inativo', AREA_ATUACAO:'PR',                  DATA_ADMISSAO:null,         FOTO_URL:null },
      { ID_COLABORADOR:'COL-0005', NOME_COMPLETO:'Denise Marcarini',           CARGO:'Credenciadora',                       SETOR_ID:'SET-024', GESTOR_DIRETO:'COL-0001', EMAIL:'credenciamentosul03@redeselect.com.br',        TELEFONE:'(51) 99314-2582', RAMAL:null,  CIDADE:'Canoas',    ESTADO:'RS', STATUS:'Ativo',   AREA_ATUACAO:'RS',                  DATA_ADMISSAO:null,         FOTO_URL:null },
    ]
  };
}

// ─── START ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
