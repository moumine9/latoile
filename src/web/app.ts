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
  commitCount?: number;
  commits?: Array<{
    sha: string;
    shortSha?: string;
    title?: string;
    author?: string;
    timestamp?: string;
    url?: string;
  }>;
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
  closedNeighborhood(): CyCollection;
  degree(includeLoops: boolean): number;
}

interface CyCollection {
  forEach(callback: (element: CyElement) => void): void;
  addClass(name: string): void;
  removeClass(name: string): void;
}

interface CyEventObject {
  target: CyElement | CyCore;
}

interface CyCore {
  on(event: 'tap', selector: string, handler: (evt: CyEventObject) => void): void;
  on(event: 'tap', handler: (evt: CyEventObject) => void): void;
  edges(): CyCollection;
  elements(): CyCollection;
  zoom(): number;
  zoom(level: number): void;
  fit(): void;
  style(stylesheet: CyStylesheet[]): void;
  png(options?: { output?: 'base64uri' | 'blob'; bg?: string; full?: boolean }): string;
  // Only ever passed to JSON.stringify, so the loose `object` type suffices.
  json(): object;
}

type StyleValue = string | number | ((element: CyElement) => string | number);

interface CyStylesheet {
  selector: string;
  style: Record<string, StyleValue>;
}

interface CyLayoutOptions {
  name: string;
  animate?: boolean;
  padding?: number;
  nodeDimensionsIncludeLabels?: boolean;
  idealEdgeLength?: number;
  nodeRepulsion?: number;
  componentSpacing?: number;
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
/** Node counts by type from the last rendered graph, for the legend. */
let legendCounts: Record<string, number> = {};

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
      const next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      savePref('theme', next);
      buildLegend();
      if (cy) {
        cy.style(cyStyle());
      }
    });
  }

  restorePrefs();
  els.depth.addEventListener('change', () => savePref('depth', els.depth.value));
  els.nodes.addEventListener('change', () => savePref('nodes', els.nodes.value));

  // Allow deep-linking: ?key=JIRA-123
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key');
  if (key) {
    els.key.value = key;
    void loadGraph();
  }

  setupSearch();
}

/* ---------------------------- user preferences ---------------------------- */

const PREFS_STORAGE_KEY = 'latoile-prefs';

interface Prefs {
  theme?: string;
  depth?: string;
  nodes?: string;
}

function loadPrefs(): Prefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) || '{}') as Prefs;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePref(name: keyof Prefs, value: string): void {
  try {
    const prefs = loadPrefs();
    prefs[name] = value;
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — preferences are best-effort.
  }
}

/** Applies saved theme/depth/nodes on startup. */
function restorePrefs(): void {
  const prefs = loadPrefs();
  if (prefs.theme === 'light' || prefs.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', prefs.theme);
    buildLegend();
  }
  if (prefs.depth && /^\d+$/.test(prefs.depth)) els.depth.value = prefs.depth;
  if (prefs.nodes && /^\d+$/.test(prefs.nodes)) els.nodes.value = prefs.nodes;
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let currentSearchAbort: AbortController | null = null;
let searchItems: SearchResult[] = [];
let selectedIndex = -1;

const RECENT_STORAGE_KEY = 'latoile-recent-keys';
const RECENT_MAX = 8;

/** True when the value looks like a (partial) issue key rather than free text. */
function isKeyLike(value: string): boolean {
  return /^(PV2-)?[0-9]*$/i.test(value);
}

/** True when the value is a pasted GitLab merge-request link. */
function isMrUrl(value: string): boolean {
  return /^https?:\/\/\S+\/-\/merge_requests\/\d+/.test(value);
}

function getRecentKeys(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]') as string[];
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function recordRecentKey(key: string): void {
  try {
    const list = [key, ...getRecentKeys().filter((k) => k !== key)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable (private mode) — recents are best-effort.
  }
}

function setupSearch(): void {
  els.key.addEventListener('input', () => {
    // Key-like input (number or PV2- prefix) and MR links submit directly;
    // only free text of 3+ characters triggers the JQL search.
    const val = els.key.value.trim();
    if (!val || val.length < 3 || isKeyLike(val) || isMrUrl(val)) {
      hideResults();
      return;
    }

    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => performSearch(val), 300);
  });

  els.key.addEventListener('keydown', (e: KeyboardEvent) => {
    const visible = !els.searchResults.classList.contains('hidden');
    if (e.key === 'Escape') {
      hideResults();
      return;
    }
    if (e.key === 'ArrowDown' && !visible && !els.key.value.trim()) {
      // Empty field: arrow down opens the recent-lookups list.
      e.preventDefault();
      showRecentKeys();
      return;
    }
    if (!visible || searchItems.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      const item = searchItems[selectedIndex];
      if (item) {
        e.preventDefault();
        chooseResult(item.key);
      }
    }
  });

  // Hide search results when clicking outside
  document.addEventListener('click', (e) => {
    if (!els.key.contains(e.target as Node) && !els.searchResults.contains(e.target as Node)) {
      hideResults();
    }
  });

  els.key.addEventListener('focus', () => {
    const val = els.key.value.trim();
    if (!val) {
      showRecentKeys();
    } else if (val.length >= 3 && !isKeyLike(val) && els.searchResults.children.length > 0) {
      els.searchResults.classList.remove('hidden');
    }
  });
}

function hideResults(): void {
  els.searchResults.classList.add('hidden');
  selectedIndex = -1;
}

/** Fills the input with the chosen key and loads its graph immediately. */
function chooseResult(key: string): void {
  els.key.value = key;
  hideResults();
  els.key.focus();
  void loadGraph();
}

function moveSelection(delta: number): void {
  const count = searchItems.length;
  if (count === 0) return;
  selectedIndex = (selectedIndex + delta + count) % count;
  const nodes = els.searchResults.querySelectorAll('.search-result-item');
  nodes.forEach((node, i) => {
    node.classList.toggle('selected', i === selectedIndex);
    if (i === selectedIndex) (node as HTMLElement).scrollIntoView({ block: 'nearest' });
  });
}

/** Escapes `text` for HTML while wrapping case-insensitive matches of `query` in <mark>. */
function highlightMatch(text: string, query: string): string {
  if (!query) return esc(text);
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      out += esc(text.slice(i));
      return out;
    }
    out += `${esc(text.slice(i, idx))}<mark>${esc(text.slice(idx, idx + q.length))}</mark>`;
    i = idx + q.length;
  }
}

function renderResults(items: SearchResult[], query: string, emptyMessage: string): void {
  searchItems = items;
  selectedIndex = -1;
  els.searchResults.innerHTML = '';
  els.searchResults.classList.remove('hidden');

  if (items.length === 0) {
    els.searchResults.innerHTML = `<div class="search-result-item"><div class="search-result-summary">${esc(emptyMessage)}</div></div>`;
    searchItems = [];
    return;
  }

  items.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: baseline;">
        <span class="search-result-key">${esc(r.key)}</span>
        <span class="search-result-type">${esc(r.type)}</span>
      </div>
      <div class="search-result-summary" title="${esc(r.summary)}">${highlightMatch(r.summary, query)}</div>
    `;
    item.addEventListener('click', () => chooseResult(r.key));
    item.addEventListener('mousemove', () => {
      if (selectedIndex !== i) {
        selectedIndex = i;
        els.searchResults
          .querySelectorAll('.search-result-item')
          .forEach((node, j) => node.classList.toggle('selected', j === i));
      }
    });
    els.searchResults.appendChild(item);
  });
}

function showRecentKeys(): void {
  const recents = getRecentKeys();
  if (recents.length === 0) return;
  renderResults(
    recents.map((key) => ({ key, summary: 'Recent lookup', type: '' })),
    '',
    ''
  );
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
    // Clear stale results so keyboard navigation can't select an item from
    // the previous query while the new search is in flight.
    searchItems = [];
    selectedIndex = -1;
    els.searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-summary">Searching...</div></div>';
    els.searchResults.classList.remove('hidden');
    
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      signal: currentSearchAbort.signal
    });
    
    if (!res.ok) throw new Error('Search failed');

    const results = (await res.json()) as SearchResult[];
    renderResults(results, query, 'No results found');
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
    searchItems = [];
    selectedIndex = -1;
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

function computeLegendCounts(graph: GraphPayload): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of graph.nodes) {
    const bucket = n.type === 'jira' && n.isEntry ? 'jira_entry' : n.type;
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  return counts;
}

function buildLegend(): void {
  els.legend.innerHTML = '';
  const items: Array<[string, string]> = [
    ['jira', 'Jira issue'],
    ['jira_entry', 'Entry point'],
    ['merge_request', 'Merge request'],
    ['doc', 'Doc'],
  ];
  const colors = getTypeColors();
  for (const [type, label] of items) {
    const count = legendCounts[type];
    // Hide types absent from the current graph, but show the full legend
    // before any graph has been loaded.
    if (Object.keys(legendCounts).length > 0 && !count) continue;
    const span = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colors[type] ?? '';
    span.append(dot, document.createTextNode(count ? `${label} (${count})` : label));
    els.legend.append(span);
  }
}

async function onSubmit(event: Event): Promise<void> {
  event.preventDefault();
  await loadGraph();
}

function setStatus(message: string, isError = false): void {
  // Keep the bar short: collapse whitespace and hard-cap the length; the full
  // message stays available on hover via the title attribute.
  const compact = message.replace(/\s+/g, ' ').trim();
  els.status.textContent = truncate(compact, 90);
  els.status.title = message; // Show full text on hover
  els.status.classList.toggle('error', isError);
}

async function loadGraph(): Promise<void> {
  const rawInput = els.key.value.trim();
  if (!rawInput) return;

  let key: string;
  if (isMrUrl(rawInput)) {
    // Pasted MR link: ask the backend to resolve it to a Jira key first.
    els.button.disabled = true;
    els.overlay.classList.remove('hidden');
    els.loadingText.textContent = 'Resolving merge request…';
    setStatus('Resolving merge request…');
    try {
      const res = await fetch(`/api/resolve-mr?url=${encodeURIComponent(rawInput)}`);
      const data = (await res.json()) as { key?: string; mrIid?: number; error?: string };
      if (!res.ok || !data.key) throw new Error(data.error || 'MR resolution failed');
      key = data.key;
      els.key.value = key;
      setStatus(`Resolved MR !${data.mrIid ?? '?'} → ${key}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      els.button.disabled = false;
      els.overlay.classList.add('hidden');
      return;
    }
  } else {
    key = rawInput.toUpperCase();
    // Auto-prepend PV2- if only a number is entered
    if (/^\d+$/.test(key)) {
      key = `PV2-${key}`;
      els.key.value = key;
    }
  }

  els.button.disabled = true;
  els.overlay.classList.remove('hidden');
  els.loadingText.textContent = `Fetching ${key}…`;
  setStatus(`Fetching ${key}…`);

  const query = new URLSearchParams({
    maxDepth: els.depth.value || '1',
    maxNodes: els.nodes.value || '50',
  });

  const url = `/api/graph/${encodeURIComponent(key)}?${query}`;

  try {
    const source = new EventSource(url);

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'log') {
          // Progress detail lives in the loading overlay; the status bar keeps
          // the stable "Fetching KEY…" message instead of every log line.
          els.loadingText.textContent = payload.message;
        } else if (payload.type === 'result') {
          const data = payload.data as GraphPayload;
          render(data);
          recordRecentKey(key);
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
  legendCounts = computeLegendCounts(graph);
  buildLegend();
  const elements: CyElementDef[] = [
    ...graph.nodes.map((n): CyElementDef => ({ data: { ...n, label: nodeLabel(n) } })),
    ...graph.edges.map((e): CyElementDef => ({ data: e })),
  ];

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: cyStyle(),
    layout: {
      name: 'cose',
      animate: false,
      padding: 40,
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: 90,
      nodeRepulsion: 8000,
      componentSpacing: 80,
    },
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
      highlightNeighborhood(evt.target as CyElement);
      tapTimeout = setTimeout(() => {
        tapTimeout = null;
      }, 300); // 300ms window for double tap
    }
  });

  cy.on('tap', (evt: CyEventObject) => {
    if (evt.target === cy) {
      showEmptyDetails();
      clearHighlight();
    }
  });
  applyEdgeFilter();
}

/** Fades everything except the tapped node and its direct neighbors. */
function highlightNeighborhood(node: CyElement): void {
  if (!cy) return;
  cy.elements().addClass('faded');
  node.closedNeighborhood().removeClass('faded');
}

function clearHighlight(): void {
  if (!cy) return;
  cy.elements().removeClass('faded');
}

function nodeLabel(node: GraphNodeData): string {
  switch (node.type) {
    case 'jira':
      return `${node.key ?? node.id}${node.title ? `\n${truncate(node.title, 28)}` : ''}`;
    case 'merge_request':
      return `!${node.iid}${node.commitCount ? ` · ${node.commitCount} commit${node.commitCount > 1 ? 's' : ''}` : ''}\n${truncate(node.title || '', 24)}`;
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

/** Jira nodes grow with their connectivity so hubs stand out; capped at 44px. */
function nodeSize(ele: CyElement): number {
  if (ele.data().type !== 'jira') return 26;
  return Math.min(44, 24 + ele.degree(false) * 2);
}

function edgeColorFor(type: string): string {
  const colors = getTypeColors();
  const byType: Record<string, string | undefined> = {
    parent: colors.jira,
    subtask: colors.jira,
    sibling: getThemeColor('muted'),
    mention: getThemeColor('muted'),
    link: colors.doc,
    has_mr: colors.merge_request,
    documented_by: colors.doc,
  };
  return byType[type] || getThemeColor('doc');
}

function cyStyle(): CyStylesheet[] {
  const textColor = getThemeColor('text');
  const mutedColor = getThemeColor('muted');
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
        width: (ele: CyElement) => nodeSize(ele),
        height: (ele: CyElement) => nodeSize(ele),
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
      selector: 'node[type="doc"]',
      style: { shape: 'round-rectangle' },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': (ele: CyElement) => edgeColorFor(ele.data('type')),
        'target-arrow-color': (ele: CyElement) => edgeColorFor(ele.data('type')),
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
    { selector: '.faded', style: { opacity: 0.15 } },
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
    body += row('Branch', esc(node.sourceBranch));
    body += row('Target', esc(node.targetBranch));
    body += row('Author', esc(node.author));
    body += row('URL', link(node.url, node.url));
    body += '</dl>';
    if (Array.isArray(node.commits) && node.commits.length) {
      body += `<div class="section-title">Commits (${node.commits.length})</div><ul class="commit-list">`;
      for (const c of node.commits) {
        const label = `${c.shortSha || c.sha.slice(0, 7)} ${c.title || ''}`.trim();
        body += `<li>${link(c.url, label)}</li>`;
      }
      body += '</ul>';
    }
  } else if (node.type === 'doc') {
    body += `<h2>${esc(node.title)}</h2>`;
    body += `<dl>${row('Source', esc(node.source))}${row('URL', link(node.url, node.url))}</dl>`;
  } else {
    body += `<h2>${esc(node.id)}</h2>`;
  }

  els.details.innerHTML = body;
}
