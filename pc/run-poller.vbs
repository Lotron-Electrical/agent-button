' Launch the agent-button poller with no visible console window.
' Used by the AgentButtonPoller scheduled task (and fine to double-click).
Set sh = CreateObject("WScript.Shell")
repo = "C:\Users\Lloyd Gibbs\Claude Projects\agent-button"
sh.CurrentDirectory = repo
sh.Run "node """ & repo & "\pc\poller.js""", 0, False
