!macro preInit
  !ifdef APP_ARM64
  !ifndef APP_64
  !ifndef BUILD_UNINSTALLER
    SetRegView 64
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 == ""
      WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\${APP_FILENAME}"
    ${EndIf}
  !endif
  !endif
  !endif
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SondraAD"
!macroend
