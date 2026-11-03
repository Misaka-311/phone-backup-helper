' Phone Backup Helper - silent launcher (no console window)
' Called by the desktop shortcut: wscript.exe "phone-backup.vbs"
Option Explicit

Dim fso, sh, base, nodeExe, rc, script, cmd, logFile

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

base    = fso.GetParentFolderName(WScript.ScriptFullName)
script  = fso.BuildPath(base, "src\server.mjs")
logFile = fso.BuildPath(base, "logs\launcher.log")
sh.CurrentDirectory = base

If Not fso.FileExists(script) Then
  MsgBox "src\server.mjs not found next to this script.", vbExclamation, "Phone Backup Helper"
  WScript.Quit 1
End If

' Prefer node from PATH; fall back to a common install location
nodeExe = "node"
rc = sh.Run("cmd /c where node >nul 2>nul", 0, True)
If rc <> 0 Then
  nodeExe = "D:\tool\node\node.exe"
End If
If nodeExe <> "node" And Not fso.FileExists(nodeExe) Then
  MsgBox "Node.js was not found. Install it from https://nodejs.org " & _
         "or edit this file and set nodeExe to your node.exe path.", _
         vbExclamation, "Phone Backup Helper"
  WScript.Quit 1
End If

cmd = """" & nodeExe & """ """ & script & """"

On Error Resume Next
sh.Run cmd, 0, False
If Err.Number <> 0 Then
  MsgBox "Launch failed: " & Err.Description, vbExclamation, "Phone Backup Helper"
  WScript.Quit 1
End If
On Error Goto 0
