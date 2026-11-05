; Liaison desktop installer hooks, included by tauri's NSIS template.
;
; WHY THIS FILE EXISTS: an update is a run of the installer, and the PATH
; entry has to be right after every one of them, pointing at the directory the
; NEW build uses. tauri's template writes nothing to PATH, so this file adds
; the element on every install and every update and removes it on uninstall.
;
; WHAT THIS FILE DOES NOT DO: write the uninstall entry. tauri's template
; writes `Uninstall\${PRODUCTNAME}` in full on every run (DisplayName,
; DisplayVersion, Publisher, InstallLocation, UninstallString) and deletes it
; on uninstall, so a second key written here was a SECOND "Liaison" row in
; Installed Apps, which is what the first real Windows install showed. The
; scheme below is the same key the template writes; it is kept so the command
; names the executable this file's other paths name, and both delete it.
;
; THE PATH ENTRY IS NOT WRITTEN BY HAND. An NSIS string holds 1024 characters
; by default, and a developer's user PATH is routinely longer than that. Read
; such a PATH into a register and write it back and the tail is gone, silently:
; every tool the customer had on their command line yesterday stops resolving,
; and nothing points at the Liaison installer as the cause. The EnVar plugin
; adds and removes ONE element without ever materialising the whole value, and
; its AddValue is idempotent, so twenty updates leave one entry and the
; uninstall removes it again. apps/desktop/ci/install-nsis-envar.ps1 puts the
; plugin on the build machine, pinned by hash, in a directory this pipeline
; owns: tauri deletes and re-extracts its own NSIS directory whenever a file it
; expects is missing, so a plugin dropped in there does not survive a cold
; build machine.
;
; Per-user throughout (HKCU, no HKLM): the install is per user by design, see
; apps/desktop/ci/windows-installer.md. HKLM here would need elevation on every
; update, which is the prompt that decision exists to avoid.
;
; NOTHING MAY STILL RUN FROM $INSTDIR WHEN THE FILES ARE WRITTEN (2026-09-28).
; An update is this installer started by the OLD app with /P /UPDATE /R, and
; the old app's updater exits without stopping its children. tauri's template
; kills a running ${MAINBINARYNAME}.exe (CheckIfAppIsRunning, right after the
; PREINSTALL hook) and nothing else: a local session's liaison-sidecar.exe,
; the Claude CLI it runs and a sign in watchdog all outlive the app, and
; Windows refuses to overwrite the file a running process was started from.
; In passive mode that is an "Error opening file for writing" box the user
; may never see, behind a window that has already gone. So the PREINSTALL hook
; stops every process whose executable lives in $INSTDIR, with its child tree,
; and waits until the files can be written. The update itself is fixed on the
; app side too (updater.rs), but that fix only reaches users once they run it:
; this hook is in the NEW build's installer, which is what every update runs.
; Every step is appended to the shell's own updater.log, so a failed update
; can be read afterwards.

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"

; Where the EnVar plugin was installed, read at COMPILE time. Unset means
; nobody ran the install script, and a build that carries on from there writes
; no PATH entry at all while reporting success.
!if "$%LIAISON_NSIS_PLUGINS%" == ""
  !error "LIAISON_NSIS_PLUGINS is not set: run apps/desktop/ci/install-nsis-envar.ps1 first, it installs the EnVar plugin this file needs"
!else
  !addplugindir /x86-unicode "$%LIAISON_NSIS_PLUGINS%"
!endif

; The template includes this file BEFORE its own !define lines (BUNDLEID,
; PRODUCTNAME, VERSION, MAINBINARYNAME are all defined a few lines below the
; include). So nothing at the top level of this file may read or define those
; symbols: a fallback !define here collides with the template's own define, and
; an !ifndef here always fires. The macros below are only expanded from the
; NSIS_HOOK_* insertion points, after the defines, which is where the symbols
; are read and where the guard lives.
;
; MAINBINARYNAME is the executable every path registered below points AT, so a
; guessed value registers a scheme, an icon and an uninstall entry naming a file
; that does not exist. The app still installs and still launches, and only the
; deep links are dead. A missing define stops the build instead.
!macro LiaisonRequireTemplateDefines
  !ifndef MAINBINARYNAME
    !error "MAINBINARYNAME is not defined: the bundler names the main binary, this file must not guess it"
  !endif
  !ifndef PRODUCTNAME
    !error "PRODUCTNAME is not defined by the bundler"
  !endif
  !ifndef VERSION
    !error "VERSION is not defined by the bundler"
  !endif
!macroend

; The sidecar's installed name: tauri installs `externalBin` entries under
; their base name (binaries/liaison-sidecar in tauri.conf.json), with the
; target triple stripped. windows-installer-hooks.test.ts ties the two.
!define LIAISON_SIDECAR_EXE "liaison-sidecar.exe"

;
; THE BUNDLE IDENTIFIER CHANGED (after desktop 0.1.19). Nothing the template keys an
; existing install on uses it: the uninstall entry is Uninstall\${PRODUCTNAME},
; the remembered install directory is Software\${MANUFACTURER}\${PRODUCTNAME}
; (MANUFACTURER is tauri.conf.json's explicit bundle.publisher; without it the
; bundler would derive it from the identifier) and $INSTDIR defaults to
; $LOCALAPPDATA\${PRODUCTNAME}. So an update installs over the old build in
; place, with one row in Installed Apps. What DOES carry the identifier: the
; app's data directories (the shell copies them across on its first launch,
; identifier_migration.rs), the shortcuts' AppUserModelID (restamped below,
; because an update run skips creating shortcuts and the old ID would leave
; the new build's notifications unattributed), and the uninstaller's "delete
; app data" (which now removes the legacy directories too).
!define LIAISON_LEGACY_BUNDLEID "com.embodme.liaison.desktop"

; THE PUBLISHER SHOWN IN INSTALLED APPS is the Authenticode signer, not
; tauri.conf.json's bundle.publisher. The template writes that value both as the
; uninstall entry's Publisher and as MANUFACTURER, the key it remembers a custom
; install directory under (Software\${MANUFACTURER}\${PRODUCTNAME}) and reads in
; .onInit and in the reinstall page, before any hook runs. Renaming it would make
; an update lose a customer's chosen directory, so bundle.publisher stays as it
; was and the post-install hook overwrites only the displayed Publisher. Keep it
; equal to the -Publisher the release workflow verifies the signatures against.
!define LIAISON_PUBLISHER "Mathieu Frohlich"

; This file's own directory, read HERE at the top level: inside a macro,
; __FILEDIR__ would be the directory of tauri's generated installer.nsi, where
; the macro is expanded. tauri includes this file by its canonical path.
!define LIAISON_HOOKS_DIR "${__FILEDIR__}"

; One line in %LOCALAPPDATA%\<identifier>\logs\updater.log, the file the shell
; writes its own update steps to (updater.rs). Best effort: a log that cannot
; be written never stops an install. The text is expanded into $8 FIRST: it
; names the caller's $0 and $1, which ${GetTime} overwrites, and the first run
; on Windows logged the day and the month as PowerShell's exit code and output.
!macro LiaisonLog text
  Push $8
  StrCpy $8 "${text}"
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $9
  CreateDirectory "$LOCALAPPDATA\${BUNDLEID}\logs"
  ClearErrors
  FileOpen $9 "$LOCALAPPDATA\${BUNDLEID}\logs\updater.log" a
  ${IfNot} ${Errors}
    FileSeek $9 0 END
    ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
    FileWrite $9 "$2-$1-$0 $4:$5:$6 local [installer ${VERSION}] $8$\r$\n"
    FileClose $9
  ${EndIf}
  Pop $9
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $8
!macroend

; Waits until `file` can be opened for writing, which is exactly what the
; File command after this hook needs. A missing file (a first install) is
; writable. Leaves $R9 at 1 when it is, 0 when it is still locked.
!macro LiaisonWaitWritable file tries
  StrCpy $R9 0
  StrCpy $R8 0
  ${Do}
    ${IfNot} ${FileExists} "${file}"
      StrCpy $R9 1
      ${Break}
    ${EndIf}
    ClearErrors
    FileOpen $R7 "${file}" a
    ${IfNot} ${Errors}
      FileClose $R7
      StrCpy $R9 1
      ${Break}
    ${EndIf}
    IntOp $R8 $R8 + 1
    ${If} $R8 >= ${tries}
      ${Break}
    ${EndIf}
    Sleep 250
  ${Loop}
!macroend

; Stops what is left of Liaison in $INSTDIR: our own binaries only, never
; anything else that runs from the same folder, and never with a tree kill of
; the app this installer descends from (an update's installer is its child).
; The rules live in stop-leftovers.ps1, beside this file, which says why each
; one exists and is run by windows-installer-hooks.test.ts; the logic outgrew
; what an NSIS string holds. Its inputs reach it through the environment,
; never through the command text, so a quote in a user name cannot break or
; inject into it. Scoped to this user as well: a process of another user shows
; no ExecutablePath to an unelevated query and cannot be killed by one.
!macro LiaisonStopProcessesInInstdir
  Push $0
  Push $1
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  InitPluginsDir
  File "/oname=$PLUGINSDIR\liaison-stop-leftovers.ps1" "${LIAISON_HOOKS_DIR}\stop-leftovers.ps1"
  System::Call 'kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LIAISON_SELF_PID", t "$0")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LIAISON_INSTDIR", t "$INSTDIR")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LIAISON_NAMES", t "${MAINBINARYNAME}.exe,${LIAISON_SIDECAR_EXE}")i'
  ; The script waits up to 15 s for the app to exit and prints only at the
  ; end, so 30 s of silence means WMI hung: nsExec gives up ("timeout") and
  ; the fallback below still runs.
  !insertmacro LiaisonLog "running the stop script (installer pid $0)"
  nsExec::ExecToStack /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\liaison-stop-leftovers.ps1"`
  Pop $0
  Pop $1
  !insertmacro LiaisonLog "stop script in $INSTDIR (exit $0): $1"

  ; Termination is asynchronous: a file stays locked until its process is
  ; fully gone, and after this hook the template's own check finds nothing
  ; running and does not wait. So both binaries are waited for (two seconds),
  ; then the fallback by image name for this user (a machine where PowerShell
  ; or WMI failed or timed out), then five more seconds each. The main binary
  ; is killed ALONE there: it may be the installer's own parent.
  !insertmacro LiaisonWaitWritable "$INSTDIR\${LIAISON_SIDECAR_EXE}" 8
  StrCpy $R6 $R9
  !insertmacro LiaisonWaitWritable "$INSTDIR\${MAINBINARYNAME}.exe" 8
  ${If} $R6 = 0
  ${OrIf} $R9 = 0
    ; By image NAME, for this user, not by path: this is the path for a
    ; machine where PowerShell or WMI failed, and taskkill has no filter on
    ; the executable's path (its /FI filters are name, pid, user, session,
    ; status, window title, modules, services, cpu and memory), while wmic,
    ; which could match on the path, is WMI again and is gone from current
    ; Windows 11. The names are ours alone, so what this can reach beyond
    ; $INSTDIR is another Liaison install of the same user.
    ; $%USERNAME% would be the BUILD machine's user, read at compile time.
    ReadEnvStr $1 USERNAME
    nsExec::ExecToStack /TIMEOUT=10000 'taskkill.exe /F /T /IM ${LIAISON_SIDECAR_EXE} /FI "USERNAME eq $1"'
    Pop $0
    Pop $R7
    nsExec::ExecToStack /TIMEOUT=10000 'taskkill.exe /F /IM ${MAINBINARYNAME}.exe /FI "USERNAME eq $1"'
    Pop $R8
    Pop $R7
    !insertmacro LiaisonLog "still locked, taskkill by name (sidecar exit $0, main exit $R8)"
    !insertmacro LiaisonWaitWritable "$INSTDIR\${LIAISON_SIDECAR_EXE}" 20
    StrCpy $R6 $R9
    !insertmacro LiaisonWaitWritable "$INSTDIR\${MAINBINARYNAME}.exe" 20
  ${EndIf}
  ${If} $R6 = 0
    !insertmacro LiaisonLog "WARNING: $INSTDIR\${LIAISON_SIDECAR_EXE} is still locked"
  ${EndIf}
  ${If} $R9 = 0
    !insertmacro LiaisonLog "WARNING: $INSTDIR\${MAINBINARYNAME}.exe is still locked"
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LiaisonRequireTemplateDefines
  !insertmacro LiaisonLog "started: $CMDLINE"
  !insertmacro LiaisonStopProcessesInInstdir
!macroend

; An uninstall has the same problem: a sidecar still running keeps its file,
; and the uninstall leaves it behind in a directory the user thinks is gone.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LiaisonRequireTemplateDefines
  !insertmacro LiaisonStopProcessesInInstdir
!macroend

!macro LiaisonRegisterAll
  !insertmacro LiaisonRequireTemplateDefines
  ; --- The liaison:// URL scheme ------------------------------------------
  ; Rewritten in full, not patched: the executable path is what changes
  ; between versions and it is the whole value.
  WriteRegStr HKCU "Software\Classes\liaison" "" "URL:Liaison Protocol"
  WriteRegStr HKCU "Software\Classes\liaison" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\liaison\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\liaison\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; --- The PATH entry, one element, added by the plugin ---------------------
  ; AddValue appends the directory as an element and returns 0 when it is
  ; already there, so this is the idempotency guard as well as the write.
  EnVar::SetHKCU
  EnVar::AddValue "Path" "$INSTDIR"
  Pop $0
  ${If} $0 != 0
    ; Dropping the return code would leave the command line silently without
    ; the app and the install reporting success.
    DetailPrint "Liaison: could not add $INSTDIR to the user PATH (EnVar code $0)"
  ${EndIf}

  ; Without this the new PATH exists in the registry and in no running
  ; process, so the first thing the customer types still fails.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

; An update run (/UPDATE) leaves existing shortcuts alone, so a shortcut made
; by a build with the legacy identifier keeps that AppUserModelID, and Windows
; ties toasts and taskbar grouping to the ID the shortcut carries. The
; template's SetLnkAppUserModelId stamps ${BUNDLEID}; it is defined in the
; template's utils.nsh, included before this file, and a template that drops
; it has to stop the build rather than skip this silently.
!macro LiaisonRestampShortcutIds
  !ifmacrondef SetLnkAppUserModelId
    !error "tauri's template no longer defines SetLnkAppUserModelId: shortcuts from the legacy identifier would keep its AppUserModelID"
  !endif
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "Publisher" "${LIAISON_PUBLISHER}"
  !insertmacro LiaisonRegisterAll
  !insertmacro LiaisonRestampShortcutIds
  !insertmacro LiaisonLog "installed to $INSTDIR"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro LiaisonRequireTemplateDefines
  ; Leaving the scheme behind means liaison:// links keep opening a path that
  ; no longer exists.
  DeleteRegKey HKCU "Software\Classes\liaison"

  ; And leaving the directory in PATH leaves a dead entry there for the life of
  ; the machine, one more per install and uninstall cycle. DeleteValue removes
  ; every copy of the element, with the whole value never read.
  EnVar::SetHKCU
  EnVar::DeleteValue "Path" "$INSTDIR"
  Pop $0
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; "Delete app data" removes $APPDATA and $LOCALAPPDATA under ${BUNDLEID}
  ; (the template, same condition). The shell copied its data there from the
  ; legacy identifier's directories and left those in place for a rollback,
  ; so they go too, or the user's tokens outlive the uninstall they asked for.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\${LIAISON_LEGACY_BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${LIAISON_LEGACY_BUNDLEID}"
  ${EndIf}
!macroend
