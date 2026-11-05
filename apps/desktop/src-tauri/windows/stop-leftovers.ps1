# Stops what is left of Liaison in the install directory before the installer
# writes its files. Run by installer-hooks.nsi (LiaisonStopProcessesInInstdir)
# with everything it needs in the environment, never in the command text:
#
#   LIAISON_INSTDIR       the install directory
#   LIAISON_NAMES         our own image names, comma separated (the main binary
#                         and liaison-sidecar.exe)
#   LIAISON_SELF_PID      the installer's own process id
#   LIAISON_WAIT_SECONDS  how long to let the app exit on its own (default 15)
#
# WHY THE ANCESTOR CHAIN (review of 2026-09-28). An update's installer is a
# CHILD of the app that downloaded it, liaison-desktop.exe (0.1.9's
# ShellExecuteW and the shell's own launch alike), which lives in $INSTDIR
# (the product is called Liaison; no file is named Liaison.exe). A tree
# kill (taskkill /T) of it kills the installer too, with this script and its
# taskkill: the incident again, by our own hand. So the installer's ancestors
# are computed first; the script waits for one of ours among them to exit on
# its own (it is quitting already), and one still alive after the wait is
# killed ALONE, never with its tree. Its other children, and every other
# process of ours, go with their trees: the sidecar's Claude CLI lives
# outside $INSTDIR and only a tree kill reaches it.
#
# WHY ONLY OUR NAMES. A user may install into a shared folder (D:\Apps); a
# match on the directory alone would kill whatever else runs from there.
#
# WHY SO PLAIN. Under Smart App Control or any WDAC policy this file runs in
# Constrained Language Mode: no .NET method calls, no type literals beyond the
# core ones. Operators (-ieq, -replace, -in, -split) and cmdlets only.
# windows-installer-hooks.test.ts runs it under ConstrainedLanguage.

$ErrorActionPreference = 'Continue'

$dir = $env:LIAISON_INSTDIR -replace '[\\/]+$', ''
$names = @($env:LIAISON_NAMES -split ',' | Where-Object { $_ })
$self = '' + $env:LIAISON_SELF_PID
$waitSeconds = 15
if ($env:LIAISON_WAIT_SECONDS) { $waitSeconds = 0 + $env:LIAISON_WAIT_SECONDS }

# Process ids are keys as STRINGS, everywhere. Win32_Process types them
# UInt32, and any arithmetic widens them (0 + a UInt32 is an Int64): a
# hashtable keyed one way and read another finds nothing. The first real
# Windows run did exactly that, the ancestor chain came out empty, and the
# app was tree killed with the installer under it.
function Get-ProcessTable {
  $table = @{}
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process)) {
    $table['' + $process.ProcessId] = $process
  }
  $table
}

# One of ours: one of our image names, started from $INSTDIR itself.
function Test-Ours($process) {
  if (-not $process.ExecutablePath) { return $false }
  if (-not ($process.Name -in $names)) { return $false }
  $parent = $process.ExecutablePath -replace '[\\/][^\\/]*$', ''
  return ($parent -ieq $dir)
}

# The installer and every process above it. A parent id whose process started
# AFTER its child is a reused id, not the parent: the walk stops there.
function Get-AncestorChain($table) {
  $chain = @{}
  $current = $self
  for ($step = 0; $step -lt 64; $step++) {
    $process = $table[$current]
    if ($null -eq $process) { break }
    $chain[$current] = $true
    $parentId = '' + $process.ParentProcessId
    if ($parentId -eq '0' -or $chain[$parentId]) { break }
    $parent = $table[$parentId]
    if ($null -eq $parent) { break }
    if ($parent.CreationDate -and $process.CreationDate -and $parent.CreationDate -gt $process.CreationDate) { break }
    $current = $parentId
  }
  $chain
}

# The wait: an ancestor of ours is the app that started this update, and it is
# exiting. Bounded by the CLOCK, not by a number of checks: one process query
# takes about a second under a 32 bit Windows PowerShell, and a count of sixty
# checks became more than a minute on the first real Windows run.
$start = Get-Date
$waited = 0
while ($true) {
  $table = Get-ProcessTable
  $chain = Get-AncestorChain $table
  $leaving = @($table.Values | Where-Object { $chain['' + $_.ProcessId] -and (Test-Ours $_) })
  $waited = [int]((Get-Date) - $start).TotalMilliseconds
  if ($leaving.Count -eq 0) { break }
  if ($waited -ge ($waitSeconds * 1000)) { break }
  Start-Sleep -Milliseconds 250
}

$table = Get-ProcessTable
$chain = Get-AncestorChain $table
$stopped = @()
foreach ($process in @($table.Values | Sort-Object ProcessId)) {
  if (-not (Test-Ours $process)) { continue }
  $id = '' + $process.ProcessId
  if ($chain[$id]) {
    # Still alive after the wait, and above the installer: alone. Its children
    # that are not ours and not in the chain go with their trees; the ones
    # that are ours are handled by this same loop.
    foreach ($child in @($table.Values | Where-Object { ('' + $_.ParentProcessId) -eq $id })) {
      $childId = '' + $child.ProcessId
      if ($chain[$childId] -or (Test-Ours $child)) { continue }
      taskkill.exe /F /T /PID $childId | Out-Null
    }
    taskkill.exe /F /PID $id | Out-Null
    $stopped += ($process.Name + ':' + $id + ' alone')
  } else {
    taskkill.exe /F /T /PID $id | Out-Null
    $stopped += ($process.Name + ':' + $id)
  }
}

'waited ' + $waited + ' ms; stopped ' + ($stopped -join ', ')
