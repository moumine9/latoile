<#
.SYNOPSIS
  Bulk-index every local git repo under a root into the shared Orbit Local graph.

.DESCRIPTION
  Orbit stores all repos in one DuckDB graph (~/.orbit/graph.duckdb), scoped per
  (repo_path, branch, commit_sha). This walks the immediate subdirectories of
  -Root, indexes each git repo SEQUENTIALLY (the graph is single-writer — parallel
  indexing silently drops writes), and prints per-repo stats plus a total.

  Re-run after pulling / switching branches to refresh; indexing re-parses the repo.

.PARAMETER Root
  Directory whose immediate children are repo checkouts. Default: D:\repos
  (the canonical tree — do NOT also index C:\repos, the duplicate mirror, or
  cross-repo queries double-count).

.PARAMETER Clean
  Delete the shared graph (~/.orbit/graph.duckdb) before indexing, for a from-
  scratch rebuild. Use this to drop stale entries (old branches, repos indexed
  from another tree) rather than let them accumulate. NOTE: this wipes ALL repos
  from the graph, including any indexed from outside -Root — re-add them after.

.EXAMPLE
  pwsh -File scripts/orbit-reindex.ps1
  pwsh -File scripts/orbit-reindex.ps1 -Root D:\repos -Clean
#>
[CmdletBinding()]
param(
  [string]$Root = 'D:\repos',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'

# Resolve the orbit binary: PATH first (set by the installer, needs a fresh
# terminal), then the default install location.
$orbit = (Get-Command orbit -ErrorAction SilentlyContinue)?.Source
if (-not $orbit) {
  $fallback = Join-Path $env:LOCALAPPDATA 'Programs\orbit\orbit.exe'
  if (Test-Path $fallback) { $orbit = $fallback }
}
if (-not $orbit) {
  throw "orbit CLI not found on PATH or at $env:LOCALAPPDATA\Programs\orbit\orbit.exe. Install it first (see PLAN-ORBIT.md)."
}

if (-not (Test-Path $Root)) { throw "Root not found: $Root" }

if ($Clean) {
  # Remove the DuckDB file plus any WAL/lock siblings for a clean rebuild.
  $graph = Join-Path $env:USERPROFILE '.orbit\graph.duckdb'
  Get-Item "$graph*" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Cleaned existing graph at $graph`n"
}

$repos = Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName '.git') } |
  Sort-Object Name

if (-not $repos) { Write-Host "No git repos found under $Root"; return }

Write-Host "Indexing $($repos.Count) repo(s) under $Root with $orbit`n"

$totFiles = 0; $totDefs = 0; $totRels = 0; $failed = @()
foreach ($repo in $repos) {
  $name = $repo.Name
  try {
    # stdout carries the JSON stats; per-file parse warnings go to stderr — drop them.
    $out = & $orbit index $repo.FullName 2>$null | Out-String
    $stats = $out | ConvertFrom-Json
    $g = $stats.graph
    $totFiles += $g.files; $totDefs += $g.definitions; $totRels += $g.relationships
    "{0,-24} files={1,-6} defs={2,-8} rels={3,-8} ({4:N1}s, skipped={5})" -f `
      $name, $g.files, $g.definitions, $g.relationships, $stats.time_seconds, $stats.processing.skipped_files
  } catch {
    $failed += $name
    "{0,-24} FAILED: {1}" -f $name, $_.Exception.Message
  }
}

Write-Host ("`nTotal: {0} repos | {1} files | {2} definitions | {3} relationships" -f `
  ($repos.Count - $failed.Count), $totFiles, $totDefs, $totRels)
if ($failed) { Write-Host ("Failed: {0}" -f ($failed -join ', ')) }
