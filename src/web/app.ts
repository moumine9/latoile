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
  strength?: 'strong' | 'weak';
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
  zoom(): number;
  zoom(level: number): void;
  fit(): void;
  style(stylesheet: CyStylesheet[]): void;
  png(options?: { output?: 'base64uri' | 'blob'; bg?: string; full?: boolean }): string;
  // Only ever passed to JSON.stringify, so the loose `object` type suffices.
  json(): object;
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
  zoomingEnabled?: boolean;
  userZoomingEnabled?: boolean;
  userPanningEnabled?: boolean;
  boxSelectionEnabled?: boolean;
  autoungrabify?: boolean;
  autolock?: boolean;
  minZoom?: number;
  maxZoom?: number;
  wheelSensitivity?: number;
}

declare function cytoscape(options: CyOptions): CyCore;

/* --------------------------------- setup ---------------------------------- */

// Colors are dynamically read from CSS variables to support light/dark modes
function getThemeColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || '#888';
}

function getTypeColors(): Record<string, string> {
  return {
    jira: getThemeColor('jira'),
    jira_entry: getThemeColor('jira-entry'),
    merge_request: getThemeColor('mr'),
    branch: getThemeColor('branch'),
    commit: getThemeColor('commit'),
    doc: getThemeColor('doc'),
  };
}

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
  overlay: HTMLElement;
  loadingText: HTMLElement;
  searchResults: HTMLElement;
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
  overlay: requireElement<HTMLElement>('loading-overlay'),
  loadingText: requireElement<HTMLElement>('loading-text'),
  searchResults: requireElement<HTMLElement>('search-results'),
};

const hiddenEdgeTypes = new Set<string>();
let cy: CyCore | undefined;

init();

function init(): void {
  buildFilters();
  buildLegend();
  els.form.addEventListener('submit', onSubmit);

  requireElement<HTMLButtonElement>('zoom-in').addEventListener('click', () => {
    if (cy) cy.zoom(Math.min(cy.zoom() * 1.25, 5));
  });
  requireElement<HTMLButtonElement>('zoom-out').addEventListener('click', () => {
    if (cy) cy.zoom(Math.max(cy.zoom() / 1.25, 0.1));
  });
  requireElement<HTMLButtonElement>('zoom-fit').addEventListener('click', () => {
    if (cy) cy.fit();
  });

  requireElement<HTMLButtonElement>('export-png').addEventListener('click', () => {
    if (!cy) return;
    const png64 = cy.png({ output: 'base64uri', full: true, bg: getThemeColor('bg') });
    const a = document.createElement('a');
    a.href = png64;
    a.download = `latoile-${els.key.value || 'graph'}.png`;
    a.click();
  });

  requireElement<HTMLButtonElement>('export-json').addEventListener('click', () => {
    if (!cy) return;
    const json = JSON.stringify(cy.json(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `latoile-${els.key.value || 'graph'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
      buildLegend();
      if (cy) {
        cy.style(cyStyle());
      }
    });
  }

  // Allow deep-linking: ?key=JIRA-123
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key');
  if (key) {
    els.key.value = key;
    void loadGraph();
  }

  setupSearch();
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let currentSearchAbort: AbortController | null = null;

function setupSearch(): void {
  els.key.addEventListener('input', () => {
    // If it's matching the pattern for a key number, we don't trigger search
    // We only trigger search if it's text (not a number or PV2- prefix)
    const val = els.key.value.trim();
    if (!val || val.length < 3 || /^(PV2-)?[0-9]*$/.test(val)) {
      els.searchResults.classList.add('hidden');
      return;
    }

    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => performSearch(val), 300);
  });

  // Hide search results when clicking outside
  document.addEventListener('click', (e) => {
    if (!els.key.contains(e.target as Node) && !els.searchResults.contains(e.target as Node)) {
      els.searchResults.classList.add('hidden');
    }
  });
  
  // Show results again when focusing input if there's a valid search value
  els.key.addEventListener('focus', () => {
    const val = els.key.value.trim();
    if (val && val.length >= 3 && !/^(PV2-)?[0-9]*$/.test(val) && els.searchResults.children.length > 0) {
      els.searchResults.classList.remove('hidden');
    }
  });
}

interface SearchResult {
  key: string;
  summary: string;
  type: string;
}

async function performSearch(query: string): Promise<void> {
  if (currentSearchAbort) {
    currentSearchAbort.abort();
  }
  
  currentSearchAbort = new AbortController();
  
  try {
    els.searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-summary">Searching...</div></div>';
    els.searchResults.classList.remove('hidden');
    
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      signal: currentSearchAbort.signal
    });
    
    if (!res.ok) throw new Error('Search failed');
    
    const results = (await res.json()) as SearchResult[];
    
    els.searchResults.innerHTML = '';
    
    if (results.length === 0) {
      els.searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-summary">No results found</div></div>';
      return;
    }
    
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <span class="search-result-key">${esc(r.key)}</span>
          <span class="search-result-type">${esc(r.type)}</span>
        </div>
        <div class="search-result-summary" title="${esc(r.summary)}">${esc(r.summary)}</div>
      `;
      
      item.addEventListener('click', () => {
        els.key.value = r.key;
        els.searchResults.classList.add('hidden');
        els.key.focus();
        // Since we are overriding pattern, when clicking a result it's a full valid key
        // The pattern validation handles form submit logic natively.
      });
      
      els.searchResults.appendChild(item);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
    els.searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-summary" style="color:var(--error)">Search failed</div></div>';
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
  const colors = getTypeColors();
  for (const [type, label] of items) {
    const span = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colors[type] ?? '';
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
  els.status.title = message; // Show full text on hover
  els.status.classList.toggle('error', isError);
}

async function loadGraph(): Promise<void> {
  let key = els.key.value.trim().toUpperCase();
  if (!key) return;

  // Auto-prepend PV2- if only a number is entered
  if (/^\d+$/.test(key)) {
    key = `PV2-${key}`;
    els.key.value = key;
  }

  els.button.disabled = true;
  els.overlay.classList.remove('hidden');
  els.loadingText.textContent = `Fetching ${key}…`;
  setStatus(`Fetching ${key}…`);

  const query = new URLSearchParams({
    maxDepth: els.depth.value || '2',
    maxNodes: els.nodes.value || '100',
  });

  const url = `/api/graph/${encodeURIComponent(key)}?${query}`;

  try {
    const source = new EventSource(url);

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'log') {
          els.loadingText.textContent = payload.message;
          setStatus(payload.message);
        } else if (payload.type === 'result') {
          const data = payload.data as GraphPayload;
          render(data);
          const s: GraphStats = data.stats || {};
          setStatus(`${s.nodes ?? '?'} nodes · ${s.edges ?? '?'} edges · fetched ${s.fetched ?? '?'} Jira issues`);
          source.close();
          els.button.disabled = false;
          els.overlay.classList.add('hidden');
        } else if (payload.type === 'error') {
          throw new Error(payload.error);
        }
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
        source.close();
        els.button.disabled = false;
        els.overlay.classList.add('hidden');
      }
    };

    source.onerror = () => {
      setStatus(`Connection error or stream closed unexpectedly`, true);
      source.close();
      els.button.disabled = false;
      els.overlay.classList.add('hidden');
    };
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    els.button.disabled = false;
    els.overlay.classList.add('hidden');
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
    zoomingEnabled: true,
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
    autoungrabify: false, // Ensures nodes can be grabbed and dragged
    autolock: false,      // Ensures nodes are not locked in place
    minZoom: 0.1,
    maxZoom: 5,
    wheelSensitivity: 0.2,
  });

  // Double-click to open the external link
  let tapTimeout: ReturnType<typeof setTimeout> | null = null;
  cy.on('tap', 'node', (evt: CyEventObject) => {
    const node = (evt.target as CyElement).data();
    
    if (tapTimeout) {
      // Double tap detected
      clearTimeout(tapTimeout);
      tapTimeout = null;
      if (node.url) {
        window.open(node.url, '_blank', 'noopener,noreferrer');
      }
    } else {
      // Single tap
      showDetails(node);
      tapTimeout = setTimeout(() => {
        tapTimeout = null;
      }, 300); // 300ms window for double tap
    }
  });

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
      return truncate(node.title || node.shortSha || (node.sha || '').slice(0, 8), 30);
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
  const colors = getTypeColors();
  if (node.type === 'jira' && node.isEntry) return colors.jira_entry ?? '#888';
  return colors[node.type] || '#888';
}

function cyStyle(): CyStylesheet[] {
  const textColor = getThemeColor('text');
  const mutedColor = getThemeColor('muted');
  const docColor = getThemeColor('doc');
  const branchColor = getThemeColor('branch');
  const panelColor = getThemeColor('panel');

  return [
    {
      selector: 'node',
      style: {
        'background-color': (ele: CyElement) => colorFor(ele.data()),
        label: 'data(label)',
        color: textColor,
        'font-size': 9,
        'text-wrap': 'wrap',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        width: 26,
        height: 26,
        cursor: 'pointer',
      },
    },
    {
      selector: 'node[type="jira"][?isEntry]',
      style: { width: 40, height: 40, 'border-width': 3, 'border-color': panelColor },
    },
    {
      selector: 'node[?resolved][type="jira"]',
      style: {},
    },
    {
      selector: 'node[type="jira"][!resolved]',
      style: { 'background-opacity': 0.4, 'border-style': 'dashed', 'border-width': 1, 'border-color': mutedColor },
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
        'line-color': docColor,
        'target-arrow-color': docColor,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(type)',
        'font-size': 7,
        color: branchColor,
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
    {
      selector: 'edge[strength="weak"]',
      style: { 'line-style': 'dotted', opacity: 0.55 },
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
  els.details.classList.add('hidden');
  els.details.innerHTML = '<p class="muted">Select a node to see its details. Double-click a node to open it in Jira/GitLab.</p>';
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
  els.details.classList.remove('hidden');
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
