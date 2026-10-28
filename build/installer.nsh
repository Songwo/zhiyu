; 安装升级后刷新已有入口，避免仅重命名旧快捷方式而保留旧程序与图标来源。
; 安装器 APP_ID 保持 Nanpad 以兼容原安装；Shell 使用知屿身份隔离旧任务栏缓存。
; 改名后继续使用已登记的安装目录，避免向旧目录再追加 Zhiyu 子目录。
!macro customPageAfterChangeDir
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE zhiyuInstFilesPre
  Function zhiyuInstFilesPre
    !ifndef INSTALL_MODE_PER_ALL_USERS
    ${if} $INSTDIR == $perUserInstallationFolder
      Return
    ${endIf}
    !endif
    !ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
    ${if} $INSTDIR == $perMachineInstallationFolder
      Return
    ${endIf}
    !endif
    ; 新安装仍保留模板对根目录的保护。
    Call instFilesPre
  FunctionEnd
!macroend

!macro zhiyuApplyStartup REGISTRY_KEY
  ; 在线引导器显式传入偏好；普通离线安装不传此参数，不改变已有设置。
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/ZH_STARTUP=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "1"
      WriteRegStr SHELL_CONTEXT "${REGISTRY_KEY}" "Zhiyu" '$\"$appExe$\"'
    ${ElseIf} $R1 == "0"
      DeleteRegValue SHELL_CONTEXT "${REGISTRY_KEY}" "Zhiyu"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro zhiyuApplyStartup "Software\Microsoft\Windows\CurrentVersion\Run"
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${if} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\zhiyu.ico" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newStartMenuLink" "dev.songwo.zhiyu"
    ${endIf}
  !endif
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
    ${andIf} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\zhiyu.ico" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newDesktopLink" "dev.songwo.zhiyu"
    ${endIf}
  !endif
  ; 通知资源管理器更新图标，不清空全局缓存，也不重启资源管理器。
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro zhiyuRemoveStartup REGISTRY_KEY
  ; 只移除指向当前卸载目录的自启项，不碰其他程序或另一安装位置。
  ReadRegStr $R0 SHELL_CONTEXT "${REGISTRY_KEY}" "Zhiyu"
  ${If} $R0 == '$\"$INSTDIR\Zhiyu.exe$\"'
    DeleteRegValue SHELL_CONTEXT "${REGISTRY_KEY}" "Zhiyu"
  ${EndIf}
!macroend

!macro customUnInstall
  ; 覆盖升级也会调用旧卸载器；升级不能删掉用户已经开启的自启偏好。
  ${ifNot} ${isUpdated}
    !insertmacro zhiyuRemoveStartup "Software\Microsoft\Windows\CurrentVersion\Run"
  ${endIf}
!macroend
