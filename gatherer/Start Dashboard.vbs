' Starts Gatherer in the background (no terminal window) and opens the
' dashboard in your browser. Double-click to run. Everything else, including
' starting and stopping bots, updating and shutting down, is on the dashboard.
' Output goes to logs\gatherer.log.
Option Explicit
Dim shell, fso, dir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\logs") Then fso.CreateFolder dir & "\logs"

If shell.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
    MsgBox "Node.js isn't installed. Get the LTS version from https://nodejs.org, then try again.", vbExclamation, "Gatherer"
    WScript.Quit 1
End If
If Not fso.FolderExists(dir & "\node_modules") Then
    MsgBox "First start: installing what Gatherer needs. This takes a minute; the dashboard opens when it's done.", vbInformation, "Gatherer"
    shell.Run "cmd /c npm install --no-audit --no-fund >> logs\gatherer.log 2>&1", 0, True
End If

' If it's already running, the new copy notices and closes; the browser still opens.
shell.Run "cmd /c node gatherer.js --manager >> logs\gatherer.log 2>&1", 0, False
WScript.Sleep 3000
shell.Run "http://localhost:3000/"
