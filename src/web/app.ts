/* latoile frontend — live graph visualizer.
 * Fetches the graph from the backend and renders it with Cytoscape.
 *
 * Compiled from TypeScript to `public/app.js` (see `tsconfig.web.json`).
 * Cytoscape is loaded as a global from a CDN <script> tag in index.html; only
 * the subset of its API used here is declared below. */

/* -------------------------- graph payload shapes -------------------------- */

interface DocRef {
  url?: string;
  title?: string;
}

interface GraphNodeData {
  id: string;
  type: string;
  key?: string;
  title?: string;
  iid?: number;
  name?: string;
  shortSha?: string;
  sha?: string;
  isEntry?: boolean;
  resolved?: boolean;
  issueType?: string;
  status?: string;
  assignee?: string;
  parentKey?: string;
  depth?: number;
  documentation?: DocRef[];
  project?: string;
  state?: string;
  sourceBranch?: string;
  targetBranch?: string;
  author?: string;
  url?: string;
  source?: string;
  timestamp?: string;
  label?: string;
}

interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  linkType?: string;
}

interface GraphStats {
  nodes?: number;
  edges?: number;
  fetched?: number;
}

interface GraphPayload {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  stats?: GraphStats;
  error?: string;
}

/* --------------------------- minimal cytoscape ---------------------------- */

interface CyElement {
  data(): GraphNodeData;
  data(key: string): string;
  addClass(name: string): void;
  removeClass(name: string): void;
}

interface CyCollection {
  forEach(callback: (element: CyElement) => void): void;
}

interface CyEventObject {
  target: CyElement | CyCore;
}

interface CyCore {
  on(event: 'tap', selector: string, handler: (evt: CyEventObject) => void): void;
  on(event: 'tap', handler: (evt: CyEventObject) => void): void;
  edges(): CyCollection;
}

type StyleValue = string | number | ((element: CyElement) => string);

interface CyStylesheet {
  selector: string;
  style: Record<string, StyleValue>;
}

interface CyLayoutOptions {
  name: string;
  animate?: boolean;
  padding?: number;
  nodeDimensionsIncludeLabels?: boolean;
}

interface CyElementDef {
  data: GraphNodeData | GraphEdgeData;
}

interface CyOptions {
  container: HTMLElement | null;
  elements: CyElementDef[];
  style: CyStylesheet[];
  layout: CyLayoutOptions;
}

declare function cytoscape(options: CyOptions): CyCore;

/* --------------------------------- setup ---------------------------------- */

const TYPE_COLORS: Record<string, string> = {
  jira: '#2684ff',
  jira_entry: '#ff8b00',
  merge_request: '#fc6d26',
  branch: '#6f42c1',
  commit: '#2da44e',
  doc: '#d0a215',
};

const EDGE_TYPES: string[] = [
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

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

interface Elements {
  form: HTMLFormElement;
  key: HTMLInputElement;
  depth: HTMLInputElement;
  nodes: HTMLInputElement;
  button: HTMLButtonElement;
  status: HTMLElement;
  filters: HTMLElement;
  legend: HTMLElement;
  details: HTMLElement;
}

const queryButton = document.querySelector<HTMLButtonElement>('#query-form button');
if (!queryButton) throw new Error('Missing submit button in #query-form');

const els: Elements = {
  form: requireElement<HTMLFormElement>('query-form'),
  key: requireElement<HTMLInputElement>('jira-key'),
  depth: requireElement<HTMLInputElement>('max-depth'),
  nodes: requireElement<HTMLInputElement>('max-nodes'),
  button: queryButton,
  status: requireElement<HTMLElement>('status'),
  filters: requireElement<HTMLElement>('filters'),
  legend: requireElement<HTMLElement>('legend'),
  details: requireElement<HTMLElement>('details'),
};

const hiddenEdgeTypes = new Set<string>();
let cy: CyCore | undefined;

init();

function init(): void {
  buildFilters();
  buildLegend();
  els.form.addEventListener('submit', onSubmit);

  // Allow deep-linking: ?key=JIRA-123
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key');
  if (key) {
    els.key.value = key;
    void loadGraph();
  }
}

function buildFilters(): void {
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

function buildLegend(): void {
  els.legend.innerHTML = '';
  const items: Array<[string, string]> = [
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
    dot.style.background = TYPE_COLORS[type] ?? '';
    span.append(dot, document.createTextNode(label));
    els.legend.append(span);
  }
}

async function onSubmit(event: Event): Promise<void> {
  event.preventDefault();
  await loadGraph();
}

function setStatus(message: string, isError = false): void {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

async function loadGraph(): Promise<void> {
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
    const data = (await res.json()) as GraphPayload;
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    render(data);
    const s: GraphStats = data.stats || {};
    setStatus(`${s.nodes ?? '?'} nodes · ${s.edges ?? '?'} edges · fetched ${s.fetched ?? '?'} Jira issues`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    els.button.disabled = false;
  }
}

function render(graph: GraphPayload): void {
  const elements: CyElementDef[] = [
    ...graph.nodes.map((n): CyElementDef => ({ data: { ...n, label: nodeLabel(n) } })),
    ...graph.edges.map((e): CyElementDef => ({ data: e })),
  ];

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: cyStyle(),
    layout: { name: 'cose', animate: false, padding: 40, nodeDimensionsIncludeLabels: true },
  });

  cy.on('tap', 'node', (evt: CyEventObject) => showDetails((evt.target as CyElement).data()));
  cy.on('tap', (evt: CyEventObject) => {
    if (evt.target === cy) showEmptyDetails();
  });
  applyEdgeFilter();
}

function nodeLabel(node: GraphNodeData): string {
  switch (node.type) {
    case 'jira':
      return `${node.key ?? node.id}${node.title ? `\n${truncate(node.title, 28)}` : ''}`;
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

function truncate(str: string, n: number): string {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function colorFor(node: GraphNodeData): string {
  if (node.type === 'jira' && node.isEntry) return TYPE_COLORS.jira_entry ?? '#888';
  return TYPE_COLORS[node.type] || '#888';
}

function cyStyle(): CyStylesheet[] {
  return [
    {
      selector: 'node',
      style: {
        'background-color': (ele: CyElement) => colorFor(ele.data()),
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

function applyEdgeFilter(): void {
  if (!cy) return;
  cy.edges().forEach((edge: CyElement) => {
    if (hiddenEdgeTypes.has(edge.data('type'))) edge.addClass('hidden');
    else edge.removeClass('hidden');
  });
}

/* ------------------------------- details -------------------------------- */

function showEmptyDetails(): void {
  els.details.innerHTML = '<p class="muted">Select a node to see its details.</p>';
}

function esc(value: string | number | boolean | null | undefined): string {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function row(term: string, value: string): string {
  if (value === '') return '';
  return `<dt>${esc(term)}</dt><dd>${value}</dd>`;
}

function link(url: string | undefined, text: string | undefined): string {
  if (!url) return esc(text || '');
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>`;
}

function showDetails(node: GraphNodeData): void {
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
