/* latoile frontend — live graph visualizer.
 * Fetches the graph from the backend and renders it with Cytoscape. */

const TYPE_COLORS = {
  jira: '#2684ff',
  jira_entry: '#ff8b00',
  merge_request: '#fc6d26',
  branch: '#6f42c1',
  commit: '#2da44e',
  doc: '#d0a215',
};

const EDGE_TYPES = [
  'parent',
  'subtask',
  'sibling',
  'link',
  'mention',
  'has_mr',
  'has_branch',
  'has_commit',
  'documented_by',
];

const els = {
  form: document.getElementById('query-form'),
  key: document.getElementById('jira-key'),
  depth: document.getElementById('max-depth'),
  nodes: document.getElementById('max-nodes'),
  button: document.querySelector('#query-form button'),
  status: document.getElementById('status'),
  filters: document.getElementById('filters'),
  legend: document.getElementById('legend'),
  details: document.getElementById('details'),
};

const hiddenEdgeTypes = new Set();
let cy;

init();

function init() {
  buildFilters();
  buildLegend();
  els.form.addEventListener('submit', onSubmit);

  // Allow deep-linking: ?key=JIRA-123
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key');
  if (key) {
    els.key.value = key;
    loadGraph();
  }
}

function buildFilters() {
  els.filters.innerHTML = '';
  for (const type of EDGE_TYPES) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => {
      if (cb.checked) hiddenEdgeTypes.delete(type);
      else hiddenEdgeTypes.add(type);
      applyEdgeFilter();
    });
    label.append(cb, document.createTextNode(type));
    els.filters.append(label);
  }
}

function buildLegend() {
  els.legend.innerHTML = '';
  const items = [
    ['jira', 'Jira issue'],
    ['jira_entry', 'Entry point'],
    ['merge_request', 'Merge request'],
    ['branch', 'Branch'],
    ['commit', 'Commit'],
    ['doc', 'Doc'],
  ];
  for (const [type, label] of items) {
    const span = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = TYPE_COLORS[type];
    span.append(dot, document.createTextNode(label));
    els.legend.append(span);
  }
}

async function onSubmit(event) {
  event.preventDefault();
  await loadGraph();
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

async function loadGraph() {
  const key = els.key.value.trim().toUpperCase();
  if (!key) return;

  els.button.disabled = true;
  setStatus(`Fetching ${key}…`);

  const query = new URLSearchParams({
    maxDepth: els.depth.value || '2',
    maxNodes: els.nodes.value || '100',
  });

  try {
    const res = await fetch(`/api/graph/${encodeURIComponent(key)}?${query}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    render(data);
    const s = data.stats || {};
    setStatus(`${s.nodes ?? '?'} nodes · ${s.edges ?? '?'} edges · fetched ${s.fetched ?? '?'} Jira issues`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.button.disabled = false;
  }
}

function render(graph) {
  const elements = [
    ...graph.nodes.map((n) => ({ data: { ...n, label: nodeLabel(n) } })),
    ...graph.edges.map((e) => ({ data: e })),
  ];

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: cyStyle(),
    layout: { name: 'cose', animate: false, padding: 40, nodeDimensionsIncludeLabels: true },
  });

  cy.on('tap', 'node', (evt) => showDetails(evt.target.data()));
  cy.on('tap', (evt) => {
    if (evt.target === cy) showEmptyDetails();
  });
  applyEdgeFilter();
}

function nodeLabel(node) {
  switch (node.type) {
    case 'jira':
      return node.key + (node.title ? `\n${truncate(node.title, 28)}` : '');
    case 'merge_request':
      return `!${node.iid}\n${truncate(node.title || '', 24)}`;
    case 'branch':
      return truncate(node.name || 'branch', 26);
    case 'commit':
      return node.shortSha || (node.sha || '').slice(0, 8);
    case 'doc':
      return truncate(node.title || 'doc', 24);
    default:
      return node.id;
  }
}

function truncate(str, n) {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function colorFor(node) {
  if (node.type === 'jira' && node.isEntry) return TYPE_COLORS.jira_entry;
  return TYPE_COLORS[node.type] || '#888';
}

function cyStyle() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': (ele) => colorFor(ele.data()),
        label: 'data(label)',
        color: '#e6e6ea',
        'font-size': 9,
        'text-wrap': 'wrap',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        width: 26,
        height: 26,
      },
    },
    {
      selector: 'node[type="jira"][?isEntry]',
      style: { width: 40, height: 40, 'border-width': 3, 'border-color': '#fff' },
    },
    {
      selector: 'node[?resolved][type="jira"]',
      style: {},
    },
    {
      selector: 'node[type="jira"][!resolved]',
      style: { 'background-opacity': 0.4, 'border-style': 'dashed', 'border-width': 1, 'border-color': '#9aa0b4' },
    },
    {
      selector: 'node[type="merge_request"]',
      style: { shape: 'round-rectangle' },
    },
    {
      selector: 'node[type="commit"]',
      style: { shape: 'diamond' },
    },
    {
      selector: 'node[type="branch"]',
      style: { shape: 'round-tag' },
    },
    {
      selector: 'node[type="doc"]',
      style: { shape: 'round-rectangle' },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': '#4a4d5e',
        'target-arrow-color': '#4a4d5e',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(type)',
        'font-size': 7,
        color: '#9aa0b4',
        'text-rotation': 'autorotate',
      },
    },
    {
      selector: 'edge[type="sibling"]',
      style: { 'line-style': 'dashed', 'target-arrow-shape': 'none' },
    },
    {
      selector: 'edge[type="mention"]',
      style: { 'line-style': 'dotted' },
    },
    { selector: '.hidden', style: { display: 'none' } },
  ];
}

function applyEdgeFilter() {
  if (!cy) return;
  cy.edges().forEach((edge) => {
    if (hiddenEdgeTypes.has(edge.data('type'))) edge.addClass('hidden');
    else edge.removeClass('hidden');
  });
}

/* ------------------------------- details -------------------------------- */

function showEmptyDetails() {
  els.details.innerHTML = '<p class="muted">Select a node to see its details.</p>';
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function row(term, value) {
  if (value == null || value === '') return '';
  return `<dt>${esc(term)}</dt><dd>${value}</dd>`;
}

function link(url, text) {
  if (!url) return esc(text || '');
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>`;
}

function showDetails(node) {
  const color = colorFor(node);
  const typeLabel = node.type === 'jira' && node.isEntry ? 'entry point' : node.type;
  let body = `<span class="badge" style="background:${color}">${esc(typeLabel)}</span>`;

  if (node.type === 'jira') {
    body += `<h2>${esc(node.key)}${node.title ? ` — ${esc(node.title)}` : ''}</h2>`;
    body += '<dl>';
    body += row('Type', esc(node.issueType));
    body += row('Status', esc(node.status));
    body += row('Assignee', esc(node.assignee));
    body += row('Parent', esc(node.parentKey));
    body += row('Depth', esc(node.depth));
    body += row('Resolved', node.resolved ? 'yes' : 'no (not fetched)');
    body += '</dl>';
    if (Array.isArray(node.documentation) && node.documentation.length) {
      body += '<div class="section-title">Documentation</div><ul>';
      for (const d of node.documentation) body += `<li>${link(d.url, d.title)}</li>`;
      body += '</ul>';
    }
  } else if (node.type === 'merge_request') {
    body += `<h2>!${esc(node.iid)} — ${esc(node.title)}</h2>`;
    body += '<dl>';
    body += row('Project', esc(node.project));
    body += row('State', esc(node.state));
    body += row('Source', esc(node.sourceBranch));
    body += row('Target', esc(node.targetBranch));
    body += row('Author', esc(node.author));
    body += row('URL', link(node.url, node.url));
    body += '</dl>';
  } else if (node.type === 'branch') {
    body += `<h2>${esc(node.name)}</h2><dl>${row('Project', esc(node.project))}</dl>`;
  } else if (node.type === 'commit') {
    body += `<h2>${esc(node.shortSha || node.sha)}</h2>`;
    body += '<dl>';
    body += row('Title', esc(node.title));
    body += row('Author', esc(node.author));
    body += row('Timestamp', esc(node.timestamp));
    body += row('SHA', esc(node.sha));
    body += '</dl>';
  } else if (node.type === 'doc') {
    body += `<h2>${esc(node.title)}</h2>`;
    body += `<dl>${row('Source', esc(node.source))}${row('URL', link(node.url, node.url))}</dl>`;
  } else {
    body += `<h2>${esc(node.id)}</h2>`;
  }

  els.details.innerHTML = body;
}
