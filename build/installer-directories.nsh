; Adapted from deepseek-ai/deepseek-harness/apps/desktop/scripts/installer-directories.nsh.
!include "LogicLib.nsh"
!define HQHARNESS_DOCUMENTS_ROOT "HuaqingDesktop"
!if "${APP_ID}" == "app.hqharness.desktop"
  !define HQHARNESS_DOCUMENTS_APP "${HQHARNESS_DOCUMENTS_ROOT}\app"
!endif

Var dshFinalDirectory
Var dshNewDirectory
Var dshOldDirectory
Var dshOldMoved
Var dshNewMoved

!macro dshExtractPayload FILE
  nsExec::ExecToStack '"$PLUGINSDIR\dsh-7za.exe" x -y -bd -bb0 "-o$INSTDIR" "${FILE}"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint $R1
    Call dshRollbackDirectories
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; The transaction renames the entire install directory, including for /S /D=.
Function dshValidateInstallDirectory
  ${If} $DOCUMENTS != ""
    GetFullPathName $R1 "$DOCUMENTS\${HQHARNESS_DOCUMENTS_ROOT}"
    GetFullPathName $R2 "$INSTDIR"
    ${If} $R2 == $R1
      Goto unsafe
    ${EndIf}
    StrCpy $R1 "$R1\default-workspace\"
    StrLen $R3 $R1
    StrCpy $R2 "$R2\" $R3
    ${If} $R2 == $R1
      Goto unsafe
    ${EndIf}
  ${EndIf}
  IfFileExists "$INSTDIR\default-workspace\." unsafe
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x400
    ${If} $0 != 0
      Goto unsafe
    ${EndIf}
  ${EndIf}
  Return

  unsafe:
    StrCpy $0 "Choose a program folder outside the default workspace."
    ${If} $LANGUAGE == 2052
      StrCpy $0 "请选择默认工作区之外的程序目录。"
    ${ElseIf} $LANGUAGE == 1028
      StrCpy $0 "請選擇預設工作區之外的程式目錄。"
    ${EndIf}
    DetailPrint $0
    MessageBox MB_ICONSTOP|MB_OK "$0" /SD IDOK
    SetErrorLevel 2
    Quit
FunctionEnd

!macro dshStageApplication
  Call dshValidateInstallDirectory
  StrCpy $dshFinalDirectory $INSTDIR
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $dshNewDirectory "$INSTDIR.new-$0"
  StrCpy $dshOldDirectory "$INSTDIR.old-$0"
  StrCpy $dshOldMoved ""
  StrCpy $dshNewMoved ""
  ClearErrors
  CreateDirectory $dshNewDirectory
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\dsh-7za.exe "${DSH_SEVENZIP_PATH}"
  StrCpy $INSTDIR $dshNewDirectory
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  File /oname=7zip-installer-LICENSE.txt "${DSH_SEVENZIP_LICENSE_DIR}\LICENSE.txt"
  File /oname=7zip-installer-COPYING.txt "${DSH_SEVENZIP_LICENSE_DIR}\COPYING"
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $dshFinalDirectory
  SetOutPath $PLUGINSDIR
!macroend

Function .onGUIEnd
  Call dshCleanupDirectories
FunctionEnd

Function dshCleanupDirectories
  ${If} $dshFinalDirectory != ""
    Call dshRollbackDirectories
  ${EndIf}
FunctionEnd

; Rollback touches only this installer's unique staging and backup paths.
Function dshRollbackDirectories
  SetOutPath $PLUGINSDIR
  ${If} $dshNewMoved == "1"
    RMDir /r "\\?\$dshFinalDirectory"
    StrCpy $dshNewMoved ""
  ${EndIf}
  ${If} $dshOldMoved == "1"
    ClearErrors
    Rename $dshOldDirectory $dshFinalDirectory
    ${If} ${Errors}
      DetailPrint "Old application retained at $dshOldDirectory"
      Return
    ${EndIf}
    StrCpy $dshOldMoved ""
  ${EndIf}
  ${If} $dshNewDirectory != ""
    RMDir /r "\\?\$dshNewDirectory"
  ${EndIf}
  StrCpy $INSTDIR $dshFinalDirectory
FunctionEnd

Function dshPromoteDirectories
  ; SetOutPath keeps a directory handle open. Release it before either rename.
  SetOutPath $PLUGINSDIR
  ClearErrors
  ${If} ${FileExists} "$dshFinalDirectory\*.*"
    Rename $dshFinalDirectory $dshOldDirectory
    ${If} ${Errors}
      Call dshRollbackDirectories
      SetErrors
      Return
    ${EndIf}
    StrCpy $dshOldMoved "1"
  ${Else}
    RMDir $dshFinalDirectory
  ${EndIf}
  ClearErrors
  Rename $dshNewDirectory $dshFinalDirectory
  ${If} ${Errors}
    Call dshRollbackDirectories
    SetErrors
    Return
  ${EndIf}
  StrCpy $dshNewMoved "1"
  SetOutPath $dshFinalDirectory
  ClearErrors
FunctionEnd

!macro dshFinishDirectories
  StrCpy $dshNewMoved ""
  ${If} $dshOldMoved == "1"
    RMDir /r "\\?\$dshOldDirectory"
    StrCpy $dshOldMoved ""
  ${EndIf}
!macroend
