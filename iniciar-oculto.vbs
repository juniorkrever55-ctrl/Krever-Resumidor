' Atalho oculto - inicia Krever sem mostrar janela preta
' Clique duplo neste arquivo para iniciar em segundo plano
' Para parar, abra Gerenciador de Tarefas e finalize node.exe

Set WshShell = CreateObject("WScript.Shell")
' Pega pasta onde está o .vbs
strPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

' Inicia npm start oculto
WshShell.Run "cmd /c cd /d """ & strPath & """ && npm start", 0, False

' Aguarda 3 segundos e abre Chrome
WScript.Sleep 3000
WshShell.Run "http://localhost:3000", 0, False

MsgBox "Krever Resumidor iniciado em segundo plano!" & vbCrLf & "Acesse: http://localhost:3000" & vbCrLf & vbCrLf & "Para parar: Gerenciador de Tarefas > Finalizar node.exe", 64, "Krever Resumidor"
