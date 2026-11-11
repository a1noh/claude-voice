' Windows launcher for Claude Voice.
' Runs server.js with no console window and restarts it if it ever stops.
' Put a shortcut to this file in your Startup folder (Win+R, shell:startup)
' to start it at login. To stop it: end "Windows Script Host" and "Node.js"
' in Task Manager.

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)

' Only one copy of this launcher at a time.
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set running = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='wscript.exe' AND CommandLine LIKE '%start-hidden.vbs%'")
If running.Count > 1 Then WScript.Quit

shell.CurrentDirectory = folder
Do
  ' 0 = hidden window, True = wait until node exits
  shell.Run "node """ & folder & "\server.js""", 0, True
  WScript.Sleep 5000
Loop
