Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
rootPath = fso.GetParentFolderName(WScript.ScriptFullName)
appPath = fso.BuildPath(fso.GetParentFolderName(rootPath), "FeishuCodexBridge.exe")
shell.Run """" & appPath & """", 0, False
