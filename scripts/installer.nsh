; Дополнительная логика установщика DM Overlay (NSIS).
;
; Подключается через nsis.include в electron-builder.yml.
;
; 1) Если приложение уже установлено, установщик при запуске спрашивает:
;    удалить приложение вместе со всеми данными или обновить его.
;    Так «удаление» делается тем же файлом, что и установка.
; 2) При удалении гарантированно чистим папки с данными приложения
;    (%APPDATA%\discord-dm-overlay, кэш и временные файлы).
;
; ВАЖНО: при обновлении (флаг --updated, который передаёт сам установщик)
; данные НЕ трогаем — иначе обновление стирало бы настройки и сессии.

!macro customInit
  ; $INSTDIR уже выставлен initMultiUser: это либо найденная установка,
  ; либо путь по умолчанию (тогда файла деинсталлятора нет).
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 dmInitDone

  ; В тихом режиме (/S) MessageBox вернёт вариант по умолчанию (IDNO) —
  ; то есть тихий запуск просто обновляет приложение.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "DM Overlay уже установлен на этом компьютере.$\r$\n$\r$\nУдалить приложение и все его данные?$\r$\n(настройки, входы в Discord и Telegram, история переписки, музыка)$\r$\n$\r$\n«Нет» — просто обновит приложение до этой версии." \
    /SD IDNO IDNO dmInitDone

  ; Деинсталлятор копируем во временную папку, чтобы он смог удалить и себя,
  ; и запускаем в тихом режиме с удалением данных.
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\${UNINSTALL_FILENAME}" "$PLUGINSDIR\dm-overlay-uninstall.exe"
  ClearErrors
  ExecWait '"$PLUGINSDIR\dm-overlay-uninstall.exe" /S --delete-app-data _?=$INSTDIR' $R0
  Sleep 500

  ; Убираем возможные остатки (например, сам файл деинсталлятора).
  RMDir /r "$INSTDIR"

  SetErrorLevel 0
  Quit

  dmInitDone:
!macroend

; Чистка данных приложения при удалении.
; ${isUpdated} истинно, когда старый деинсталлятор запущен установщиком
; в режиме обновления — в этом случае данные сохраняем.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\discord-dm-overlay"
    RMDir /r "$LOCALAPPDATA\discord-dm-overlay"
    RMDir /r "$TEMP\dm-overlay"
  ${endif}
!macroend
